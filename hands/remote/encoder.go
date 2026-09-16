package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// Waymote invokes this same executable as its FFmpeg child. Keep encoder policy
// in the distributed companion, so native hosts and both VM image architectures
// share it without a machine-local wrapper or an NVIDIA requirement.
const encoderHelperEnv = "NANOCODEX_SCREEN_ENCODER_HELPER"

func runScreenEncoder() error {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		return err
	}
	mode := os.Getenv("NANOCODEX_VIDEO_ENCODER")
	if mode == "" {
		mode = "auto"
	}
	if mode != "auto" && mode != "software" && mode != "nvenc" {
		return fmt.Errorf("invalid screen encoder %q", mode)
	}
	hardware := false
	if mode != "software" {
		candidate, err := screenEncoderArgs(os.Args[1:], true)
		if err != nil {
			return err
		}
		var size string
		var outputOptions []string
		for i := 0; i+1 < len(candidate); i++ {
			if candidate[i] == "-video_size" {
				size = candidate[i+1]
			}
			if candidate[i] == "-i" {
				outputOptions = candidate[i+2 : len(candidate)-1]
				break
			}
		}
		if size == "" || outputOptions == nil {
			return fmt.Errorf("missing raw screen dimensions")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		// Exercise the actual dimensions, pixel format and encoder options;
		// an encoder listed by FFmpeg may still lack usable hardware/drivers.
		probeArgs := append([]string{"-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=size=" + size + ":rate=60"}, outputOptions...)
		probe := exec.CommandContext(ctx, ffmpeg, append(probeArgs, "-frames:v", "1", "pipe:1")...)
		hardware = probe.Run() == nil
		cancel()
		if mode == "nvenc" && !hardware {
			return fmt.Errorf("NVENC screen encoder unavailable")
		}
	}
	args, err := screenEncoderArgs(os.Args[1:], hardware)
	if err != nil {
		return err
	}
	if hardware {
		fmt.Fprintln(os.Stderr, "Screen encoder: NVIDIA NVENC")
	} else {
		fmt.Fprintln(os.Stderr, "Screen encoder: software H.264")
	}
	command := exec.Command(ffmpeg, args...)
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stdout, os.Stderr
	return command.Run()
}

func screenEncoderArgs(original []string, hardware bool) ([]string, error) {
	values := map[string]string{}
	for i := 0; i+1 < len(original); i++ {
		values[original[i]] = original[i+1]
	}
	fps, err := strconv.Atoi(values["-framerate"])
	if err != nil || fps < 1 || fps > 240 || values["-f"] != "h264" || original[len(original)-1] != "pipe:1" {
		return nil, fmt.Errorf("unsupported screen encoder input")
	}
	bitrate := values["-b:v"]
	kbps, err := strconv.Atoi(trimK(bitrate))
	if err != nil || kbps < 1 {
		return nil, fmt.Errorf("invalid screen bitrate")
	}
	replace := map[string]string{"-maxrate": bitrate, "-bufsize": fmt.Sprintf("%dk", max(1, kbps/fps)), "-g": strconv.Itoa(max(1, fps/2)), "-keyint_min": strconv.Itoa(max(1, fps/2))}
	if hardware {
		replace["-c:v"], replace["-preset"], replace["-tune"] = "h264_nvenc", "p3", "ull"
		// NVENC converts Waymote's BGRA on the GPU. Software keeps yuv420p.
		replace["-pix_fmt"] = "bgra"
	}
	args := make([]string, 0, len(original)+16)
	for i := 0; i < len(original)-1; i++ {
		key := original[i]
		// Capture is already paced by the compositor. -re adds another clock
		// and can queue stale frames after stalls.
		if key == "-re" {
			continue
		}
		if key == "-vf" && i+1 < len(original) && original[i+1] == "scale="+strings.ReplaceAll(values["-video_size"], "x", ":") {
			i++
			continue
		}
		if hardware && (key == "-x264-params" || key == "-sc_threshold" || key == "-keyint_min") {
			i++
			continue
		}
		if value, ok := replace[key]; ok {
			args = append(args, key, value)
			i++
			continue
		}
		args = append(args, key)
	}
	if hardware {
		args = append(args, "-rc", "cbr", "-rc-lookahead", "0", "-zerolatency", "1", "-delay", "0", "-aud", "1")
	}
	return append(args, "-flush_packets", "1", "pipe:1"), nil
}

func trimK(value string) string {
	if len(value) > 0 && value[len(value)-1] == 'k' {
		return value[:len(value)-1]
	}
	return ""
}
