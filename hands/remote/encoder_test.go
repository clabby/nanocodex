package main

import (
	"fmt"
	"os"
	"strings"
	"testing"
)

// The Wayland integration tests execute this test binary as Waymote's encoder,
// exercising the same subprocess boundary as the production companion.
func TestMain(m *testing.M) {
	if os.Getenv(encoderHelperEnv) == "1" {
		if err := runScreenEncoder(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestScreenEncoderPreservesVideoContractWithoutPacingTwice(t *testing.T) {
	input := strings.Fields("-hide_banner -f rawvideo -pixel_format bgra -video_size 1600x900 -framerate 60 -re -i pipe:0 -an -c:v libx264 -preset ultrafast -tune zerolatency -profile:v baseline -pix_fmt yuv420p -b:v 6000k -maxrate 12000k -bufsize 12000k -g 60 -keyint_min 60 -sc_threshold 0 -bf 0 -x264-params aud=1:repeat-headers=1 -vf scale=1600:900 -f h264 pipe:1")
	for _, hardware := range []bool{false, true} {
		args, err := screenEncoderArgs(input, hardware)
		if err != nil {
			t.Fatal(err)
		}
		wire := " " + strings.Join(args, " ") + " "
		for _, required := range []string{" -bufsize 100k ", " -g 30 ", " -bf 0 ", " -flush_packets 1 ", " pipe:1 "} {
			if !strings.Contains(wire, required) {
				t.Fatalf("missing %q: %s", required, wire)
			}
		}
		if strings.Contains(wire, " -re ") || strings.Contains(wire, " -vf ") {
			t.Fatal("capture was paced or resized twice")
		}
		if hardware {
			if !strings.Contains(wire, " -c:v h264_nvenc ") || !strings.Contains(wire, " -aud 1 ") || strings.Contains(wire, " -x264-params ") {
				t.Fatal("invalid NVENC framing")
			}
		} else if !strings.Contains(wire, " -c:v libx264 ") || !strings.Contains(wire, " -x264-params aud=1:repeat-headers=1 ") {
			t.Fatal("software fallback lost H.264 framing")
		}
	}
}

func TestScreenEncoderRejectsMissingClockOrOutput(t *testing.T) {
	for _, args := range [][]string{nil, {"-framerate", "0"}, {"-framerate", "60", "-b:v", "6000k", "-f", "mp4", "pipe:1"}} {
		if _, err := screenEncoderArgs(args, false); err == nil {
			t.Fatal("invalid screen stream accepted")
		}
	}
}

func TestScreenNetworkPortBounds(t *testing.T) {
	for _, config := range []hostConfig{{UDPPortMin: 50000}, {UDPPortMax: 50031}, {UDPPortMin: 50031, UDPPortMax: 50000}, {UDPPortMin: 1, UDPPortMax: 65536}, {Interface: "nanocodex-no-such-interface"}} {
		if config.validateNetwork() == nil {
			t.Fatal("invalid network configuration accepted")
		}
	}
	for _, config := range []hostConfig{{}, {UDPPortMin: 50000, UDPPortMax: 50031}} {
		if err := config.validateNetwork(); err != nil {
			t.Fatal(err)
		}
	}
}
