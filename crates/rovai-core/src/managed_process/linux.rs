//! Capture descendant identities before native cancellation can orphan them.
//! A pidfd pins each signal target; numeric PIDs alone never authorize a signal.
use std::{
    collections::{BTreeMap, VecDeque},
    fs, io,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::fs::MetadataExt,
    },
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, AtomicU32, Ordering},
    },
    thread,
    time::Duration,
};

struct Identity {
    parent: i32,
    started: u64,
}

fn identity(pid: i32) -> io::Result<Identity> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat"))?;
    // comm may contain whitespace and closing parentheses.
    let fields: Vec<_> = stat
        .rsplit_once(')')
        .ok_or_else(|| io::Error::other("invalid proc stat"))?
        .1
        .split_whitespace()
        .collect();
    let invalid = || io::Error::other("invalid proc identity");
    Ok(Identity {
        parent: fields
            .get(1)
            .ok_or_else(invalid)?
            .parse()
            .map_err(|_| invalid())?,
        started: fields
            .get(19)
            .ok_or_else(invalid)?
            .parse()
            .map_err(|_| invalid())?,
    })
}

struct Process {
    started: u64,
    fd: OwnedFd,
}

impl Process {
    fn open(pid: i32, expected: &Identity) -> io::Result<Option<Self>> {
        // SAFETY: pidfd_open takes a process ID and zero flags, no pointers.
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
        if fd < 0 {
            let error = io::Error::last_os_error();
            return if error.raw_os_error() == Some(libc::ESRCH) {
                Ok(None)
            } else {
                Err(error)
            };
        }
        // SAFETY: the successful syscall returned a new, exclusively owned fd.
        let fd = unsafe { OwnedFd::from_raw_fd(fd as i32) };
        let Ok(current) = identity(pid) else {
            return Ok(None);
        };
        if current.started != expected.started || current.parent != expected.parent {
            return Ok(None);
        }
        Ok(Some(Self {
            started: current.started,
            fd,
        }))
    }

    fn exited(&self) -> io::Result<bool> {
        let mut poll = libc::pollfd {
            fd: self.fd.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: poll points to one initialized pollfd and never blocks.
        if unsafe { libc::poll(&mut poll, 1, 0) } < 0 {
            return Err(io::Error::last_os_error());
        }
        if poll.revents & libc::POLLNVAL != 0 {
            return Err(io::Error::other("invalid owned pidfd"));
        }
        Ok(poll.revents & (libc::POLLIN | libc::POLLHUP) != 0)
    }

    fn signal(&self, signal: i32) -> io::Result<()> {
        // SAFETY: this fd identifies a captured process, and null siginfo asks
        // the kernel to construct the ordinary signal metadata.
        let result = unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                self.fd.as_raw_fd(),
                signal,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            )
        };
        if result >= 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(())
        } else {
            Err(error)
        }
    }
}

pub(super) struct ProcessTree {
    processes: BTreeMap<i32, Process>,
}

impl ProcessTree {
    pub(super) fn new(pid: i32) -> io::Result<Self> {
        let root = identity(pid)?;
        let process = Process::open(pid, &root)?
            .ok_or_else(|| io::Error::other("managed root identity changed"))?;
        Ok(Self {
            processes: BTreeMap::from([(pid, process)]),
        })
    }

    pub(super) fn capture(&mut self) -> io::Result<()> {
        let exited = self
            .processes
            .iter()
            .filter_map(|(pid, process)| match process.exited() {
                Ok(true) => Some(Ok(*pid)),
                Ok(false) => None,
                Err(error) => Some(Err(error)),
            })
            .collect::<io::Result<Vec<_>>>()?;
        for pid in exited {
            self.processes.remove(&pid);
        }
        let mut children: BTreeMap<i32, Vec<(i32, Identity)>> = BTreeMap::new();
        // SAFETY: geteuid has no preconditions.
        let uid = unsafe { libc::geteuid() };
        for entry in fs::read_dir("/proc")? {
            let entry = entry?;
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<i32>().ok())
            else {
                continue;
            };
            if !entry.metadata().is_ok_and(|metadata| metadata.uid() == uid) {
                continue;
            }
            if let Ok(stat) = identity(pid) {
                children.entry(stat.parent).or_default().push((pid, stat));
            }
        }
        let mut pending: VecDeque<_> = self.processes.keys().copied().collect();
        while let Some(parent) = pending.pop_front() {
            let owned = &self.processes[&parent];
            if owned.exited()?
                || !identity(parent).is_ok_and(|current| current.started == owned.started)
            {
                continue;
            }
            for (pid, stat) in children.remove(&parent).unwrap_or_default() {
                if self.processes.contains_key(&pid) {
                    continue;
                }
                if self.processes.len() >= 16384 {
                    return Err(io::Error::other("owned process capture limit exceeded"));
                }
                if let Some(process) = Process::open(pid, &stat)? {
                    // Recheck the parent after opening the child: its PID must
                    // still denote the live ancestor that authorized capture.
                    if self.processes[&parent].exited()? {
                        break;
                    }
                    self.processes.insert(pid, process);
                    pending.push_back(pid);
                }
            }
        }
        Ok(())
    }

    pub(super) fn signal(&self, signal: i32) -> io::Result<()> {
        let mut result = Ok(());
        for process in self.processes.values().rev() {
            if let Err(error) = process.signal(signal) {
                result = Err(error);
            }
        }
        result
    }

    pub(super) fn is_empty(&self) -> io::Result<bool> {
        for process in self.processes.values() {
            if !process.exited()? {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn signal_except(&self, excluded: i32, signal: i32) -> io::Result<()> {
        let mut result = Ok(());
        for (pid, process) in self.processes.iter().rev() {
            if *pid != excluded
                && let Err(error) = process.signal(signal)
            {
                result = Err(error);
            }
        }
        result
    }

    fn empty_except(&self, excluded: i32) -> io::Result<bool> {
        for (pid, process) in &self.processes {
            if *pid != excluded && !process.exited()? {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn reap_adopted(&self, protected: u32) {
        for (pid, process) in &self.processes {
            if *pid as u32 != protected && matches!(process.exited(), Ok(true)) {
                // 只wait已捕获且已退出的子进程；不夺取portable-pty直接child的退出码。
                // SAFETY: waitpid只回收本进程的子进程；其他已退出后代返回ECHILD，无信号。
                unsafe {
                    libc::waitpid(*pid, std::ptr::null_mut(), libc::WNOHANG);
                }
            }
        }
    }
}

/// 仅专用PTY helper使用；不将Core或普通Runtime设成subreaper。
/// Core失联/硬退出时，helper收养孤立后代并以pidfd回收，主线程阻塞stdin写也不会阻止保护线程。
pub(crate) struct HelperDescendantGuard {
    stop: Arc<AtomicBool>,
    direct_child: Arc<AtomicU32>,
    launch: Arc<Mutex<()>>,
    parent: Arc<Process>,
    worker: Option<thread::JoinHandle<io::Result<()>>>,
}

impl HelperDescendantGuard {
    pub(crate) fn new(expected_parent: u32) -> io::Result<Self> {
        // SAFETY: getpid/getppid无前置条件；expected_parent只来自Core冻结启动环境。
        let own_pid = unsafe { libc::getpid() };
        if expected_parent == 0
            || expected_parent > i32::MAX as u32
            || unsafe { libc::getppid() } != expected_parent as i32
        {
            return Err(io::Error::other("canvas_terminal.helper_parent_changed"));
        }
        let parent_identity = identity(expected_parent as i32)?;
        let parent = Arc::new(
            Process::open(expected_parent as i32, &parent_identity)?
                .ok_or_else(|| io::Error::other("canvas_terminal.helper_parent_exited"))?,
        );
        // SAFETY: prctl使用Linux定义的整数参数，无指针；仅当前专用helper改变收养行为。
        if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } < 0 {
            return Err(io::Error::last_os_error());
        }
        if unsafe { libc::getppid() } != expected_parent as i32 || parent.exited()? {
            return Err(io::Error::other("canvas_terminal.helper_parent_exited"));
        }
        let mut tree = ProcessTree::new(own_pid)?;
        let stop = Arc::new(AtomicBool::new(false));
        let direct_child = Arc::new(AtomicU32::new(0));
        let launch = Arc::new(Mutex::new(()));
        let launch_barrier = launch.clone();
        let watched_parent = parent.clone();
        let stopped = stop.clone();
        let protected = direct_child.clone();
        let worker = thread::Builder::new()
            .name("canvas-pty-cleanup".into())
            .stack_size(256 * 1024)
            .spawn(move || {
                while !stopped.load(Ordering::Acquire)
                    && matches!(watched_parent.exited(), Ok(false))
                {
                    thread::sleep(Duration::from_millis(20));
                }
                stopped.store(true, Ordering::Release);
                let _launch = launch_barrier
                    .lock()
                    .map_err(|_| io::Error::other("canvas_terminal.helper_launch_poisoned"))?;
                // 不扫描普通运行中的/proc；专用subreaper保留孤立后代的可证明亲缘。
                loop {
                    tree.reap_adopted(protected.load(Ordering::Acquire));
                    if tree.capture().is_ok() {
                        let killed = tree.signal_except(own_pid, libc::SIGKILL).is_ok();
                        tree.reap_adopted(protected.load(Ordering::Acquire));
                        if killed
                            && matches!(tree.empty_except(own_pid), Ok(true))
                            && matches!(no_child_processes(), Ok(true))
                        {
                            return Ok(());
                        }
                    }
                    // 不把失败当作已清空。Core仍在时由原期限/受管进程owner决定后续收尾。
                    thread::sleep(Duration::from_millis(20));
                }
            })?;
        Ok(Self {
            stop,
            direct_child,
            launch,
            parent,
            worker: Some(worker),
        })
    }

    pub(crate) fn interruption(&self) -> Arc<AtomicBool> {
        self.stop.clone()
    }
    pub(crate) fn launch_permit(&self) -> io::Result<MutexGuard<'_, ()>> {
        let permit = self
            .launch
            .lock()
            .map_err(|_| io::Error::other("canvas_terminal.helper_launch_poisoned"))?;
        if self.stop.load(Ordering::Acquire) || self.parent.exited()? {
            return Err(io::Error::other("canvas_terminal.helper_parent_exited"));
        }
        Ok(permit)
    }
    pub(crate) fn protect_direct_child(&self, pid: u32) {
        self.direct_child.store(pid, Ordering::Release);
    }
    pub(crate) fn finish(mut self) -> io::Result<()> {
        self.stop.store(true, Ordering::Release);
        self.worker
            .take()
            .unwrap()
            .join()
            .map_err(|_| io::Error::other("canvas_terminal.helper_cleanup_panicked"))?
    }
}

fn no_child_processes() -> io::Result<bool> {
    let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
    // SAFETY: 有效输出指针，WNOHANG不阻塞，WNOWAIT不夺取portable-pty的直接child回执。
    let result = unsafe {
        libc::waitid(
            libc::P_ALL,
            0,
            info.as_mut_ptr(),
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    if result == 0 {
        return Ok(false);
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ECHILD) {
        Ok(true)
    } else {
        Err(error)
    }
}

impl Drop for HelperDescendantGuard {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
