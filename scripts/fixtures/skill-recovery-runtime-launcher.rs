// Native entry point for the isolated ACP recovery smoke, never a product Runtime.
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{env, path::PathBuf, process::Command};

fn main() {
    let node =
        PathBuf::from(env::var_os("ROVAI_ACCEPTANCE_NODE").expect("fixture Node is required"));
    let script =
        PathBuf::from(env::var_os("ROVAI_ACCEPTANCE_SCRIPT").expect("fixture script is required"));
    assert!(node.is_absolute() && node.is_file());
    assert!(script.is_absolute() && script.is_file());
    let mut child = Command::new(node);
    child.arg(script).args(env::args_os().skip(1));
    #[cfg(windows)]
    child.creation_flags(0x0800_0000);
    let status = child.status().expect("controlled ACP process must start");
    std::process::exit(status.code().unwrap_or(1));
}
