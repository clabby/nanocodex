//! Voice controls shared by the terminal UI and its rendering benchmark.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Command {
    Toggle,
    Start(Option<&'static str>),
    List,
    Stop,
    ToggleMute,
    Unmute,
    Status,
}
impl Command {
    pub(crate) fn parse(value: &str) -> Result<Self, String> {
        match value {
            "" => Ok(Self::Toggle),
            "start" | "on" => Ok(Self::Start(None)),
            "voices" => Ok(Self::List),
            "stop" | "off" => Ok(Self::Stop),
            "mute" => Ok(Self::ToggleMute),
            "unmute" => Ok(Self::Unmute),
            "status" => Ok(Self::Status),
            name => nanocodex_voice_protocol::CHATGPT_REALTIME_VOICES
                .iter()
                .find(|voice| **voice == name)
                .map(|voice| Self::Start(Some(*voice)))
                .ok_or_else(|| "Usage: /voice [on|off|mute|unmute|status|voices|VOICE]".into()),
        }
    }
}
