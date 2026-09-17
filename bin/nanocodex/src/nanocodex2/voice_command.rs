//! Voice controls shared by the terminal UI and its rendering benchmark.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Command {
    Start,
    Stop,
    Mute,
    Unmute,
    Status,
}
impl Command {
    pub(crate) fn parse(value: &str) -> Result<Self, String> {
        match value {
            "" | "start" => Ok(Self::Start),
            "stop" => Ok(Self::Stop),
            "mute" => Ok(Self::Mute),
            "unmute" => Ok(Self::Unmute),
            "status" => Ok(Self::Status),
            _ => Err("Usage: /voice [start|stop|mute|unmute|status]".into()),
        }
    }
}
