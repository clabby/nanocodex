#pragma once

#include <array>
#include <charconv>
#include <cstdint>
#include <span>
#include <string>
#include <string_view>

namespace cua::hyprland {
// The optional wire suffix is available only on production independent seats.
struct DragOptions {
    std::uint32_t button = 272;
    std::uint32_t modifiers = 0;

    template<class KeyEvent> void send_modifiers(bool pressed, KeyEvent&& key) const {
        constexpr std::array<std::uint32_t, 4> keys{42, 29, 56, 125};
        for (unsigned step = 0; step < keys.size(); ++step) {
            const auto i = pressed ? step : 3 - step;
            if (modifiers & (1u << i)) key(keys[i], pressed);
        }
    }
};

// Validate the shape, route, and entire suffix before changing request state.
// An explicit legacy-equivalent suffix still requires the advertised route.
inline std::string_view parse_drag_options(std::span<const std::string> fields,
                                           bool extension_allowed, DragOptions& out) {
    if (fields.size() == 9) { out = {}; return {}; }
    if (fields.size() != 11) return "invalid_request";
    if (!extension_allowed) return "unsupported";
    auto integer = [](std::string_view text, std::uint32_t& value) {
        if (text.empty()) return false;
        const auto [end, error] = std::from_chars(text.data(), text.data() + text.size(), value);
        return error == std::errc{} && end == text.data() + text.size();
    };
    DragOptions parsed;
    if (!integer(fields[9], parsed.button) || !integer(fields[10], parsed.modifiers) ||
        parsed.button < 272 || parsed.button > 274 || parsed.modifiers > 15)
        return "invalid_request";
    out = parsed;
    return {};
}
} // namespace cua::hyprland
