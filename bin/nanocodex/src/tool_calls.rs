/// How the transcript shows tool calls. Ctrl+O cycles through the modes.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, clap::ValueEnum)]
pub(crate) enum ToolCalls {
    /// Each call with its arguments, output, and patch.
    #[default]
    Expanded,
    /// One summary line per call.
    Folded,
    /// No tool rows; the footer still shows the turn as Working.
    Hidden,
}

impl ToolCalls {
    /// The mode Ctrl+O switches to.
    pub(crate) const fn next(self) -> Self {
        match self {
            Self::Expanded => Self::Folded,
            Self::Folded => Self::Hidden,
            Self::Hidden => Self::Expanded,
        }
    }
}
