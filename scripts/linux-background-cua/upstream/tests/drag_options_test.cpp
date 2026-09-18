#include "drag_options.hpp"

#include <cstdlib>
#include <iostream>
#include <utility>
#include <vector>

using cua::hyprland::DragOptions;
using cua::hyprland::parse_drag_options;

void check(bool value, const char* message) {
    if (!value) { std::cerr << message << '\n'; std::exit(1); }
}

int main() {
    const std::vector<std::string> legacy{"DRAG", "1", "token", "1", "10", "20", "30", "40", "200"};
    for (bool allowed : {false, true}) {
        DragOptions options{274, 15};
        check(parse_drag_options(legacy, allowed, options).empty(), "legacy request refused");
        check(options.button == 272 && options.modifiers == 0, "legacy defaults changed");
    }
    for (unsigned button = 272; button <= 274; ++button) {
        for (unsigned mask = 0; mask <= 15; ++mask) {
            auto fields = legacy;
            fields.push_back(std::to_string(button)); fields.push_back(std::to_string(mask));
            DragOptions options;
            check(parse_drag_options(fields, true, options).empty(), "valid suffix refused");
            check(options.button == button && options.modifiers == mask, "suffix lost");
            DragOptions sentinel{273, 7};
            check(parse_drag_options(fields, false, sentinel) == "unsupported", "foreground suffix accepted");
            check(sentinel.button == 273 && sentinel.modifiers == 7, "refusal mutated options");
            // Run the same modifier emitter used around native button/motion.
            std::vector<std::pair<unsigned, bool>> events;
            auto emit = [&](auto code, bool down) { events.emplace_back(code, down); };
            options.send_modifiers(true, emit);
            events.emplace_back(button, true);
            events.emplace_back(button, false);
            options.send_modifiers(false, emit);
            std::vector<std::pair<unsigned, bool>> expected;
            if (mask & 1) expected.emplace_back(42, true);
            if (mask & 2) expected.emplace_back(29, true);
            if (mask & 4) expected.emplace_back(56, true);
            if (mask & 8) expected.emplace_back(125, true);
            expected.emplace_back(button, true); expected.emplace_back(button, false);
            if (mask & 8) expected.emplace_back(125, false);
            if (mask & 4) expected.emplace_back(56, false);
            if (mask & 2) expected.emplace_back(29, false);
            if (mask & 1) expected.emplace_back(42, false);
            check(events == expected, "modifier ordering or cleanup differs");
        }
    }
    const std::vector<std::pair<std::string, std::string>> bad{
        {"271", "0"}, {"275", "0"}, {"274", "16"}, {"0", "0"},
        {"-1", "0"}, {"+274", "0"}, {"274x", "0"}, {"", "0"},
        {"274", "-1"}, {"274", "1.0"}, {"274", ""}, {"274", "+1"},
        {"4294967296", "0"}, {"274", "4294967296"},
        {"18446744073709551616", "0"}, {"274", "18446744073709551616"},
    };
    for (const auto& [button, modifiers] : bad) {
        auto fields = legacy; fields.push_back(button); fields.push_back(modifiers);
        DragOptions sentinel{273, 7};
        check(parse_drag_options(fields, true, sentinel) == "invalid_request", "invalid suffix accepted");
        check(sentinel.button == 273 && sentinel.modifiers == 7, "invalid suffix mutated options");
        check(parse_drag_options(fields, false, sentinel) == "unsupported", "foreground parsed suffix");
    }
    for (unsigned count : {0u, 8u, 10u, 12u}) {
        auto fields = legacy; fields.resize(count, "0");
        DragOptions options;
        check(parse_drag_options(fields, true, options) == "invalid_request", "invalid field count accepted");
        check(parse_drag_options(fields, false, options) == "invalid_request", "invalid foreground field count accepted");
    }
    std::cout << "drag options: legacy, all 48 button/mask pairs, route refusal, malformed suffixes, ordering passed\n";
}
