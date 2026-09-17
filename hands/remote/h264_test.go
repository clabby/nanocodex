package main

import (
	"bytes"
	"encoding/binary"
	"io"
	"testing"
	"testing/iotest"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
)

func TestWaymotePipeBecomesBrowserSizedRTP(t *testing.T) {
	first := append([]byte{0, 0, 0, 1, 9, 0xf0, 0, 0, 1, 0x65}, bytes.Repeat([]byte{0x35}, 150_000)...)
	second := []byte{0, 0, 1, 9, 0xf0, 0, 0, 0, 1, 0x41, 0x35}
	stream := append(append([]byte{}, first...), second...)
	for _, reader := range []io.Reader{bytes.NewReader(stream), iotest.HalfReader(bytes.NewReader(stream))} {
		clock := time.Unix(0, 0)
		forwarder := h264Forwarder{now: func() time.Time { value := clock; clock = clock.Add(20 * time.Millisecond); return value }}
		decoder := codecs.H264Packet{}
		var decoded []byte
		count, markers := 0, 0
		err := forwarder.read(reader, func(packet *rtp.Packet) error {
			count++
			if packet.MarshalSize() > 1200 {
				t.Fatal("oversized WebRTC packet")
			}
			if packet.Timestamp != uint32((markers+1)*1800) || packet.SequenceNumber != uint16(count) {
				t.Fatal("invalid video clock or packet sequence")
			}
			if packet.Marker {
				markers++
			}
			data, err := decoder.Unmarshal(packet.Payload)
			decoded = append(decoded, data...)
			return err
		})
		// The RTP H.264 payloader discards AUDs; the encoded slices are unchanged.
		want := append([]byte{0, 0, 0, 1, 0x65}, bytes.Repeat([]byte{0x35}, 150_000)...)
		want = append(want, 0, 0, 0, 1, 0x41, 0x35)
		if err != nil || count < 100 || markers != 2 || !bytes.Equal(decoded, want) {
			t.Fatalf("frame transfer failed: %v, %d packets, %d markers, %d bytes", err, count, markers, len(decoded))
		}
	}
}

func TestWaymotePipeBoundsAndSplitDelimiters(t *testing.T) {
	unit := []byte{0, 0, 0, 1, 9, 0xf0, 0, 0, 1, 0x65, 0x35}
	stream := append(append([]byte{}, unit...), unit...)
	for _, reader := range []io.Reader{iotest.OneByteReader(bytes.NewReader(stream)), bytes.NewReader(stream)} {
		frames := 0
		err := (&h264Forwarder{}).read(reader, func(p *rtp.Packet) error {
			if p.Marker {
				frames++
			}
			return nil
		})
		if err != nil || frames != 2 {
			t.Fatalf("split delimiter: %v, %d frames", err, frames)
		}
	}
	for _, data := range [][]byte{[]byte("not video"), append(unit, bytes.Repeat([]byte{0x35}, maxH264Frame)...)} {
		if err := (&h264Forwarder{}).read(bytes.NewReader(data), func(*rtp.Packet) error { t.Fatal("invalid frame emitted"); return nil }); err == nil {
			t.Fatal("invalid stream accepted")
		}
	}
}

func TestVideoClockIncludesSkippedCaptureTime(t *testing.T) {
	unit := []byte{0, 0, 0, 1, 9, 0xf0, 0, 0, 1, 0x65, 0x35}
	times := []time.Duration{0, 20 * time.Millisecond, 220 * time.Millisecond}
	forwarder := h264Forwarder{now: func() time.Time { next := times[0]; times = times[1:]; return time.Unix(0, int64(next)) }}
	var stamps []uint32
	err := forwarder.read(bytes.NewReader(append(append([]byte{}, unit...), unit...)), func(packet *rtp.Packet) error {
		if packet.Marker {
			stamps = append(stamps, packet.Timestamp)
		}
		return nil
	})
	if err != nil || len(stamps) != 2 || stamps[1]-stamps[0] != 18000 {
		t.Fatalf("encoder stall was hidden from receiver clock: %v, %v", stamps, err)
	}
}

func TestVideoClockSurvivesLongRunningPublisherAndRTPWrap(t *testing.T) {
	unit := []byte{0, 0, 0, 1, 9, 0xf0, 0, 0, 1, 0x65, 0x35}
	times := []time.Duration{0, 36 * time.Hour}
	forwarder := h264Forwarder{now: func() time.Time { next := times[0]; times = times[1:]; return time.Unix(0, int64(next)) }}
	var stamp uint32
	err := forwarder.read(bytes.NewReader(unit), func(packet *rtp.Packet) error { stamp = packet.Timestamp; return nil })
	ticks := uint64(36*60*60) * 90000
	if err != nil || stamp != uint32(ticks) {
		t.Fatalf("long-running clock overflow: %d, %v", stamp, err)
	}
}

func TestFramedH264BoundariesAndValidation(t *testing.T) {
	frame := []byte{0, 0, 0, 1, 9, 0xf0, 0, 0, 1, 0x65, 0x35}
	var stream bytes.Buffer
	stream.WriteString(framedH264Magic)
	for range 2 {
		_ = binary.Write(&stream, binary.BigEndian, uint32(len(frame)))
		stream.Write(frame)
	}
	for _, reader := range []io.Reader{bytes.NewReader(stream.Bytes()), iotest.OneByteReader(bytes.NewReader(stream.Bytes()))} {
		count := 0
		err := readH264Frames(reader, func(got []byte) error {
			count++
			if !bytes.Equal(got, frame) {
				t.Fatal("frame changed")
			}
			return nil
		})
		if err != nil || count != 2 {
			t.Fatalf("framing failed: %v, %d", err, count)
		}
	}
	for _, payload := range [][]byte{{0, 0}, {0, 0, 0, 0}, {0, 128, 0, 1}, {0, 0, 0, 8, 0, 0, 1}, {0, 0, 0, 4, 1, 2, 3, 4}} {
		invalid := append([]byte(framedH264Magic), payload...)
		if err := readH264Frames(bytes.NewReader(invalid), func([]byte) error { t.Fatal("bad frame emitted"); return nil }); err == nil {
			t.Fatal("bad frame accepted")
		}
	}
}
