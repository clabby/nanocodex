use clap::Args;
use nanocodex_managed::{ManagedClient, ManagedError};
#[derive(Args, Default)]
pub(crate) struct DeviceHand {}
pub(crate) struct BackgroundHand;
impl BackgroundHand {
    pub(crate) fn start(_: &ManagedClient) -> Result<Self, ManagedError> {
        Ok(Self)
    }
    pub(crate) async fn stop(&mut self) {}
}
pub(crate) async fn serve(_: DeviceHand) -> Result<(), ManagedError> {
    Err(ManagedError::Configuration("Automatic computer Hands require macOS or Linux; use hand --workspace for a native workspace".into()))
}
