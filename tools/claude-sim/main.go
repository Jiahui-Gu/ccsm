// claude-sim is a stand-in binary that pretends to be the `claude` CLI.
// It is consumed by the 1h pty-soak test (Task #209 / #92): the daemon's
// pty host spawns this process instead of the real `claude` CLI, and the
// test asserts that snapshot scheduling, backpressure, ANSI passthrough,
// and idle handling all stay healthy across an hour of mixed traffic.
//
// Behaviour:
//   - Reads stdin line-by-line. EOF or "quit\n" exits cleanly.
//   - Each loop iteration emits one of four traffic patterns chosen
//     deterministically by a counter so the soak run is reproducible:
//       1. small chunked burst   — exercises the common path
//       2. 16 KiB+ flood          — exercises ring-buffer / backpressure
//       3. ANSI escape sequence  — exercises terminal passthrough
//       4. quiet idle gap        — exercises snapshot scheduler idle path
//   - Cadence is configurable via env vars so the soak harness can dial
//     it up or down without rebuilding:
//       CLAUDE_SIM_BURST_INTERVAL_MS  (default 50)   between writes inside a burst
//       CLAUDE_SIM_QUIET_MS           (default 5000) length of idle gap pattern
//       CLAUDE_SIM_FLOOD_BYTES        (default 32768) size of flood pattern
//       CLAUDE_SIM_FAST_BURST_COUNT   (default 64)  writes in fast-burst pattern
//
// No third-party deps. Compiles on darwin / linux / windows.
package main

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type config struct {
	burstIntervalMs int
	quietMs         int
	floodBytes      int
	fastBurstCount  int
}

func loadConfig() config {
	return config{
		burstIntervalMs: envInt("CLAUDE_SIM_BURST_INTERVAL_MS", 50),
		quietMs:         envInt("CLAUDE_SIM_QUIET_MS", 5000),
		floodBytes:      envInt("CLAUDE_SIM_FLOOD_BYTES", 32*1024),
		fastBurstCount:  envInt("CLAUDE_SIM_FAST_BURST_COUNT", 64),
	}
}

func envInt(name string, def int) int {
	v := os.Getenv(name)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 {
		return def
	}
	return n
}

// patterns rotate deterministically per stdin line so a soak run is
// reproducible. Each pattern returns after writing and (where relevant)
// sleeping for its idle/burst window.
func smallChunked(out *bufio.Writer, c config) {
	parts := []string{"Thinking", ".", ".", ".", " done.\n"}
	for _, p := range parts {
		_, _ = out.WriteString(p)
		_ = out.Flush()
		time.Sleep(time.Duration(c.burstIntervalMs) * time.Millisecond)
	}
}

func flood(out *bufio.Writer, c config) {
	// ASCII filler avoids accidental ANSI interpretation; one trailing
	// newline so line-buffered consumers don't stall.
	chunk := strings.Repeat("x", 1024)
	written := 0
	for written < c.floodBytes {
		_, _ = out.WriteString(chunk)
		written += len(chunk)
	}
	_, _ = out.WriteString("\n")
	_ = out.Flush()
}

func ansiEscape(out *bufio.Writer, _ config) {
	// Color + cursor moves. CCSM's pty pipeline is supposed to forward
	// these untouched; if it ever rewrites them, this line will look wrong
	// in soak diagnostics.
	const esc = "\x1b"
	seq := esc + "[31mred" + esc + "[0m " +
		esc + "[1mbold" + esc + "[0m " +
		esc + "[2A" + // cursor up 2
		esc + "[K" + // erase line
		"done\n"
	_, _ = out.WriteString(seq)
	_ = out.Flush()
}

func quietIdle(out *bufio.Writer, c config) {
	_, _ = out.WriteString("(idle)\n")
	_ = out.Flush()
	time.Sleep(time.Duration(c.quietMs) * time.Millisecond)
}

func fastBurst(out *bufio.Writer, c config) {
	for i := 0; i < c.fastBurstCount; i++ {
		_, _ = fmt.Fprintf(out, "tick %d\n", i)
	}
	_ = out.Flush()
}

var patterns = []func(*bufio.Writer, config){
	smallChunked,
	flood,
	ansiEscape,
	quietIdle,
	fastBurst,
}

func main() {
	cfg := loadConfig()
	out := bufio.NewWriterSize(os.Stdout, 64*1024)
	in := bufio.NewScanner(os.Stdin)
	// Allow long lines from the soak driver (e.g. paste-heavy prompts).
	in.Buffer(make([]byte, 64*1024), 1024*1024)

	// Greet so the harness can confirm the process is alive before sending
	// the first prompt.
	_, _ = out.WriteString("claude-sim ready\n")
	_ = out.Flush()

	step := 0
	for in.Scan() {
		line := in.Text()
		if line == "quit" {
			_, _ = out.WriteString("bye\n")
			_ = out.Flush()
			return
		}
		patterns[step%len(patterns)](out, cfg)
		step++
	}
	// EOF or scanner error -> exit 0; the soak test treats non-zero exit
	// as a regression.
	_ = out.Flush()
}
