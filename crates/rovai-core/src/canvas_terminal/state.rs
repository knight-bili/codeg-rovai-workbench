//! Codeg aff1e6c terminal manager 的代次、原子回放游标与整块回收语义。
//! 来源许可证：integration/licenses/codeg/LICENSE（Apache-2.0）。
//! 这里只管理 Core 内存状态，不启动进程，也不把请求停止当作已经退出。
use std::collections::VecDeque;

pub const OUTPUT_LIMIT: usize = 128 * 1024;
pub const READ_CHUNK_LIMIT: usize = 8192;
pub const OUTPUT_CHUNKS_LIMIT: usize = 2048;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Starting,
    Running,
    Stopping,
    Exited,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Size {
    cols: u16,
    rows: u16,
}

impl Size {
    pub fn new(cols: u16, rows: u16) -> Result<Self, &'static str> {
        if !(1..=1000).contains(&cols) || !(1..=1000).contains(&rows) {
            return Err("canvas_terminal.invalid_size");
        }
        Ok(Self { cols, rows })
    }

    pub fn cols(self) -> u16 {
        self.cols
    }
    pub fn rows(self) -> u16 {
        self.rows
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    pub seq: u64,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Replay {
    pub through_seq: u64,
    pub first_available_seq: u64,
    pub gap: bool,
    pub chunks: Vec<Chunk>,
}

/// 由持有该状态锁的同一调用分配 seq、追加原始字节和读取快照。
/// 不逐块解码 UTF-8，避免多字节字符跨两次 PTY read 时损坏。
#[derive(Debug, Default)]
struct Output {
    chunks: VecDeque<Chunk>,
    bytes: usize,
    seq: u64,
}

impl Output {
    fn append(&mut self, bytes: &[u8]) -> Result<u64, &'static str> {
        if bytes.is_empty() || bytes.len() > READ_CHUNK_LIMIT {
            return Err("canvas_terminal.invalid_output_chunk");
        }
        let seq = self
            .seq
            .checked_add(1)
            .ok_or("canvas_terminal.sequence_exhausted")?;
        self.chunks.push_back(Chunk {
            seq,
            bytes: bytes.to_vec(),
        });
        self.seq = seq;
        self.bytes += bytes.len();
        while self.bytes > OUTPUT_LIMIT || self.chunks.len() > OUTPUT_CHUNKS_LIMIT {
            self.bytes -= self
                .chunks
                .pop_front()
                .expect("nonempty bounded output")
                .bytes
                .len();
        }
        Ok(seq)
    }

    fn replay(&self, after_seq: u64) -> Result<Replay, &'static str> {
        if after_seq > self.seq {
            return Err("canvas_terminal.cursor_ahead");
        }
        let first = self
            .chunks
            .front()
            .map_or(self.seq.saturating_add(1), |chunk| chunk.seq);
        Ok(Replay {
            through_seq: self.seq,
            first_available_seq: first,
            gap: after_seq.saturating_add(1) < first,
            chunks: self
                .chunks
                .iter()
                .filter(|chunk| chunk.seq > after_seq)
                .cloned()
                .collect(),
        })
    }
}

/// 一个实际 OS 启动代次的状态。外层 Core owner 用 Mutex 持有它，
/// 重启必须构造新状态；迟到 reader/waiter 只能访问旧状态。
#[derive(Debug)]
pub struct Session {
    request_id: String,
    generation: String,
    phase: Phase,
    size: Size,
    exit_code: Option<u32>,
    output: Output,
}

impl Session {
    pub fn new(request_id: String, generation: String, size: Size) -> Self {
        Self {
            request_id,
            generation,
            phase: Phase::Starting,
            size,
            exit_code: None,
            output: Output::default(),
        }
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }
    pub fn request_id(&self) -> &str {
        &self.request_id
    }
    pub fn generation(&self) -> &str {
        &self.generation
    }
    pub fn size(&self) -> Size {
        self.size
    }
    pub fn exit_code(&self) -> Option<u32> {
        self.exit_code
    }

    pub fn require_generation(&self, generation: &str) -> Result<(), &'static str> {
        if self.generation != generation {
            return Err("canvas_terminal.stale_generation");
        }
        Ok(())
    }

    /// 必须在进程和所有资源建立成功后调用。先到的关闭令提交失败，
    /// OS 适配器随后必须终止并等待该迟到进程，不能登记为运行中。
    pub fn commit_spawn(&mut self) -> Result<(), &'static str> {
        if self.phase != Phase::Starting {
            return Err("canvas_terminal.launch_cancelled");
        }
        self.phase = Phase::Running;
        Ok(())
    }

    pub fn fail_spawn(&mut self) {
        if matches!(self.phase, Phase::Starting | Phase::Stopping) {
            self.phase = Phase::Failed;
        }
    }

    pub fn request_stop(&mut self) -> bool {
        if matches!(self.phase, Phase::Starting | Phase::Running) {
            self.phase = Phase::Stopping;
            return true;
        }
        false
    }

    /// 只有实际 wait/reap 获得退出结果后才调用；EOF 不能独自证明退出。
    pub fn finish(&mut self, exit_code: Option<u32>) {
        if matches!(self.phase, Phase::Running | Phase::Stopping) {
            self.phase = Phase::Exited;
            self.exit_code = exit_code;
        }
    }

    pub fn require_input(&self, generation: &str) -> Result<(), &'static str> {
        self.require_generation(generation)?;
        if self.phase != Phase::Running {
            return Err("canvas_terminal.not_running");
        }
        Ok(())
    }

    pub fn resized(&mut self, generation: &str, size: Size) -> Result<(), &'static str> {
        self.require_input(generation)?;
        self.size = size;
        Ok(())
    }

    pub fn append(&mut self, bytes: &[u8]) -> Result<u64, &'static str> {
        if !matches!(self.phase, Phase::Running | Phase::Stopping) {
            return Err("canvas_terminal.not_running");
        }
        self.output.append(bytes)
    }

    pub fn replay(&self, generation: &str, after_seq: u64) -> Result<Replay, &'static str> {
        self.require_generation(generation)?;
        self.output.replay(after_seq)
    }

    pub fn discard_output(&mut self) {
        self.output.chunks = VecDeque::new();
        self.output.bytes = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stop_before_spawn_and_old_generation_cannot_commit_or_write() {
        let size = Size::new(80, 24).unwrap();
        assert!(Size::new(0, 24).is_err());
        assert!(Size::new(80, 1001).is_err());
        let mut cancelled = Session::new("original-request".into(), "old".into(), size);
        assert_eq!(cancelled.request_id(), "original-request");
        assert_eq!(cancelled.generation(), "old");
        assert_eq!((size.cols(), size.rows()), (80, 24));
        assert!(cancelled.request_stop());
        assert!(!cancelled.request_stop());
        assert_eq!(cancelled.phase(), Phase::Stopping);
        assert!(cancelled.commit_spawn().is_err());
        assert!(cancelled.require_input("old").is_err());
        cancelled.finish(Some(1));
        assert_eq!(cancelled.phase(), Phase::Exited);
        assert_eq!(cancelled.exit_code(), Some(1));
        let mut current = Session::new("new-request".into(), "new".into(), size);
        current.commit_spawn().unwrap();
        assert!(current.require_input("old").is_err());
        assert!(current.replay("old", 0).is_err());
        current.require_input("new").unwrap();
        let resized = Size::new(120, 40).unwrap();
        current.resized("new", resized).unwrap();
        assert_eq!(current.size(), resized);
        assert!(current.commit_spawn().is_err());
        current.request_stop();
        current.append(b"final output").unwrap();
        current.finish(Some(7));
        assert_eq!(current.exit_code(), Some(7));
        assert!(current.append(b"late reader").is_err());
        assert!(current.resized("new", size).is_err());
        assert_eq!(
            current.replay("new", 0).unwrap().chunks[0].bytes,
            b"final output"
        );
        let mut failed = Session::new("failed".into(), "failed".into(), size);
        failed.fail_spawn();
        assert_eq!(failed.phase(), Phase::Failed);
        assert!(failed.commit_spawn().is_err());
    }

    #[test]
    fn replay_retains_whole_bounded_raw_chunks_and_reports_lost_cursor_overlap() {
        let mut session = Session::new(
            "request".into(),
            "generation".into(),
            Size::new(80, 24).unwrap(),
        );
        session.commit_spawn().unwrap();
        assert!(session.replay("generation", 0).unwrap().chunks.is_empty());
        // UTF-8 字符和转义序列故意跨块；两次回放必须保留原字节而非各自替换解码。
        session.append(&[0xe4, 0xbd]).unwrap();
        session.append(&[0xa0, 0x1b, b'[']).unwrap();
        let snapshot = session.replay("generation", 0).unwrap();
        assert!(!snapshot.gap);
        assert_eq!(snapshot.through_seq, 2);
        assert_eq!(
            snapshot
                .chunks
                .iter()
                .flat_map(|c| c.bytes.iter().copied())
                .collect::<Vec<_>>(),
            [0xe4, 0xbd, 0xa0, 0x1b, b'[']
        );
        session.append(b"31m").unwrap();
        assert_eq!(
            session
                .replay("generation", snapshot.through_seq)
                .unwrap()
                .chunks[0]
                .seq,
            3
        );
        assert!(session.append(&[]).is_err());
        assert!(session.append(&vec![0; READ_CHUNK_LIMIT + 1]).is_err());
        assert_eq!(session.replay("generation", 3).unwrap().through_seq, 3);
        for index in 0..20 {
            session.append(&vec![index; READ_CHUNK_LIMIT]).unwrap();
        }
        let retained = session.replay("generation", 0).unwrap();
        assert!(retained.gap);
        assert_eq!(retained.first_available_seq, 8);
        assert_eq!(retained.through_seq, 23);
        assert_eq!(retained.chunks.len(), 16);
        assert_eq!(
            retained.chunks.iter().map(|c| c.bytes.len()).sum::<usize>(),
            OUTPUT_LIMIT
        );
        assert!(!session.replay("generation", 7).unwrap().gap);
        assert!(session.replay("generation", 24).is_err());
        assert!(session.replay("generation", 23).unwrap().chunks.is_empty());
        session.discard_output();
        let cold = session.replay("generation", 0).unwrap();
        assert_eq!(cold.through_seq, 23);
        assert_eq!(cold.first_available_seq, 24);
        assert!(cold.gap && cold.chunks.is_empty());
        let mut tiny = Session::new("tiny".into(), "tiny".into(), Size::new(80, 24).unwrap());
        tiny.commit_spawn().unwrap();
        for _ in 0..OUTPUT_CHUNKS_LIMIT * 2 {
            tiny.append(b"x").unwrap();
        }
        let retained = tiny.replay("tiny", 0).unwrap();
        assert!(retained.gap);
        assert_eq!(retained.chunks.len(), OUTPUT_CHUNKS_LIMIT);
    }
}
