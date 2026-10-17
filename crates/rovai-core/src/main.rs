fn main() -> anyhow::Result<()> {
    if rovai_core::canvas_terminal::run_helper_if_requested()? {
        return Ok(());
    }
    rovai_core::application::run_stdio()
}
