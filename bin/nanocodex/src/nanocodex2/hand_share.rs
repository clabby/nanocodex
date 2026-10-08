//! Direct account Hand sharing commands.
use clap::{Args, Subcommand};
use nanocodex_managed::{ManagedClient, ManagedError};

#[derive(Args)]
pub(crate) struct HandShare {
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    /// Create a bearer link for a Hand you own. Share the returned URL privately.
    Create { machine_id: String },
    /// List your active shares and IDs without bearer URLs.
    List,
    /// Revoke a link and the access obtained through it.
    Revoke { id: String },
    /// Add a shared Hand to your signed-in account using its full share URL.
    Redeem { url: String },
}
impl HandShare {
    pub(super) async fn run(self, client: &ManagedClient) -> Result<(), ManagedError> {
        match self.command {
            Command::Create { machine_id } => {
                super::write_json(&client.create_hand_share(&machine_id).await?)
            }
            Command::List => super::write_json(&client.list_hand_shares().await?),
            Command::Revoke { id } => {
                client.revoke_hand_share(&id).await?;
                super::write_json(&serde_json::json!({"status": "revoked", "id": id}))
            }
            Command::Redeem { url } => super::write_json(&client.redeem_hand_share(&url).await?),
        }
    }
}
