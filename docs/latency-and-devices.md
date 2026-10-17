# Latency and devices

What you feel when you play is the time from pressing a key to hearing it. In HO[LO] that's:

1. **USB and the operating system** delivering the MIDI message to the browser (about a millisecond);
2. **the studio** passing it to the audio thread: through shared memory, so it waits at most one
   128-frame block (2.7 ms at 48 kHz) and never for the page;
3. **the browser and the sound device**: the output buffer and the device's own latency. This is the
   big part, and depends on the machine. *Audio & MIDI* settings shows it.

On Windows the third part has a floor: a browser always plays through the shared Windows mixer. To go
below it, run [HO[LO] Engine](#holo-engine) on the computer you play on.

## Seeing it

**Audio & MIDI** settings shows, live, where this device's time from key to ear goes: the output
(the browser's buffer and the sound device's), the engine (half a 128-frame block on average), any
plugin that holds the sound back, and how long USB MIDI waited for the page over the last notes. **Measure
with the microphone** plays a few clicks and listens for them: the real round trip, out of the speakers
and back, with the microphone's own share taken off where the browser reports it.

## Getting it low

- **HO[LO] Engine** ([below](#holo-engine)) takes the browser out of the path: on Windows, the biggest
  step there is.
- **Low Latency Mode** (on by default, as Logic's): plugins that hold the sound back while you play
  don't: the limiter's look-ahead (3 ms) and Shimmer's (a grain per generation). Bounces and headless
  renders always use them in full. Out of it, the mixer compensates: every path waits as long as the
  slowest one into the same bus, so a send through a look-ahead plugin still lines up with its dry
  sound, and the playhead shows what you hear.
- **Output**: choose the sound device right in HO[LO] (Chrome and Edge), for example a USB audio interface
  or wired headphones, without changing the computer's default.
- **Play where you plug in.** Plug the keyboard or drum pads into the device you're playing on, open
  HO[LO] in its browser, and wear headphones on that device. The notes never cross the network.
- **Latency: Lowest** (Audio & MIDI settings) asks the browser for its smallest buffer.
- **Compare browsers.** Chrome, Edge and Firefox all work (Firefox asks before allowing MIDI); which is
  quickest depends on the system, so open HO[LO] in each and compare the numbers in the settings.
- **On Linux**, PipeWire runs at much smaller buffers than PulseAudio. On Debian and Ubuntu, install
  `pipewire-pulse` and `wireplumber`, log out and in, then lower the quantum, e.g.
  `pw-metadata -n settings 0 clock.force-quantum 128`.
- **On Windows**, the sound device is most of the delay (on one laptop: 10 ms of Chrome's buffer and
  32–40 ms of the device). A USB audio interface usually beats the built-in sound card, wired beats
  Bluetooth by 100 ms or more, and turning off audio enhancements and matching the device to 48 kHz
  helps. Firefox's Windows audio path is often shorter than Chrome's; compare the two in the settings.
- **macOS** is excellent out of the box.

Typical output latency is about 5–10 ms on a Mac, 10–40 ms on Windows (depending on the sound device), 10–20 ms
on Linux with PipeWire, and 20–40 ms on phones. That's why a phone is better as a controller than as the speaker.

## HO[LO] Engine

HO[LO] Engine is a small app that plays the studio's sound with the computer's own audio API and reads
its USB MIDI devices natively, so neither goes through the browser. It runs the same engine as the
studio (`@holo/engine`: the same code as the studio's audio thread, the bounce and `holo render-audio`),
so it sounds the same. The studio finds it on this computer (`127.0.0.1:47830`), hands it the song with
the messages it would give its own audio thread, and keeps its own audio quiet; the playhead, the
meters and the DSP load come back from it. When it isn't running, nothing changes: the browser's audio
and Web MIDI, as before. Download it and start it as the [README](../README.md#play-it-in-a-few-milliseconds-holo-engine)
says.

How a note travels with it:

1. **USB and the operating system's MIDI** (WinMM on Windows, CoreMIDI on macOS, the ALSA sequencer on
   Linux) hand the message to HO[LO] Engine, which notes when it arrived. Every device and port is open,
   with hot-plug: notes, velocity, sustain and every other controller, pitch bend, the mod wheel and
   aftertouch, routed by each track's input and channel as the studio routes them.
2. **When the sound device next asks for sound** (once a period: 3 ms on a laptop's built-in sound in
   WASAPI exclusive mode), HO[LO] Engine takes in what has arrived and renders the 128-frame blocks
   the device needs, right then, on a thread of its own at the operating system's audio priority
   (MMCSS "Pro Audio" on Windows). A note waits half a period on average. The song itself is
   rendered a little ahead by worker threads on the other cores, as the studio's page does it
   ([Rendering ahead](architecture.md#rendering-ahead)): the render thread plays the master and
   what you play live, so a big song doesn't hold a note up.
3. **The sound device** plays it: one period's buffer in exclusive mode, then the converter.

It keeps one period rendered ahead of the device (a block that's late is then still in time), so in
exclusive mode with a 3 ms period that adds up to about 9 ms from key to ear: roughly 1 ms of USB and
driver, 1.5 ms waiting for the next period, 3 ms ahead, 3 ms of buffer and a millisecond in the sound
chip. A built-in sound chip whose shortest period is 5.3 ms comes to about 13 ms the same way.

Measured on a Windows gaming laptop, a drum machine on a USB MIDI cable. First a light test song,
through a USB soundbar, the same song both ways:

| | In the browser (Chrome) | With HO[LO] Engine |
|---|---|---|
| Output | 48.0 ms: 10.0 ms browser + 38.0 ms device, as Chrome reports them | 3.0 ms buffer (WASAPI exclusive, 3.0 ms period) + 3.0 ms rendered ahead |
| Key to ear | about 49 ms | 8.8 ms median, 11.1 ms worst, measured over 64 pad hits (about 10 ms with USB and the sound chip) |
| DSP load | | 5% average, 18% peak, no overloads |

Then a heavy one (a game's 32-track orchestral loop playing while the pads were hit), on the same laptop:

| Where the sound went | Key to ear | What happened |
|---|---|---|
| Chrome, a USB headset | about 123 ms (75 ms of it USB MIDI waiting for the page) | crackled: Chrome's audio thread at 56–78% |
| HO[LO] Engine, the USB headset or the USB soundbar, exclusive at their 3 ms period | 8.6–15.5 ms | crackled: the device ran short, once stopped and was reopened |
| HO[LO] Engine, the same devices, shared | about 33 ms (Windows' 10 ms period and 22 ms buffer) | clean |
| HO[LO] Engine, the laptop's built-in output, exclusive at its 5.3 ms period | 13.2 ms median, 17.8 ms worst, over 64 pad hits | clean; the render thread at 14% (peak 40%), the song's threads at 15–31% |

So a USB audio device that offers a very short period may not sustain it under a heavy song, while
the built-in output's longer period holds, and shared mode is the fallback on any device.

(Windows kept the microphone from desktop apps there, so neither round trip could be measured.)

What **Audio & MIDI** settings shows while it plays:

- **USB MIDI to the speakers**, measured on every note you play: from the moment the driver handed it
  over to when the device plays its first frame (its buffer included); the median and the worst of the
  last notes. Add about a millisecond for USB and the sound chip, which no software can see.
- **DSP load**: the busier of the render thread and the busiest of the threads that render the song
  ahead, as a share of each block's time; the tooltip and the settings list each one, and how often
  the render thread waited for them.
- **Measure with the microphone**: the round trip measured natively, clicks out of the device and heard
  by the system's default input. Audio tracks record from that input through HO[LO] Engine too, moved
  back by this round trip as in the browser.

**Exclusive or shared.** On Windows HO[LO] Engine opens the default output in exclusive mode, at the
device's own shortest period: the lowest latency WASAPI has, and no other app can make a sound while the
studio is open. **Share the sound device with other apps** uses Windows' shared mode instead, at the
mixer's period (10 ms on many drivers). If exclusive mode isn't possible (another app has the device
that way), it shares the device and says why. It lets go of the device, and the MIDI devices, when the
studio closes.

**How deep it buffers is its own decision, not yours.** It starts with one period rendered ahead of
the device, so a block that's late is still in time. From there it watches two things: its own render
thread (when the slowest block of the last half second takes more than 70% of the period, twice
running, it keeps a block more in hand before anything is heard) and the device (when the device runs
short, a block more at once, and never again fewer than that on this device). When the deepest
cushion still runs short, or the device itself stops under the exclusive stream, it opens the device
again at twice its shortest period, then four times; when even that fails, it shares the device and
says so. After a calm five minutes it eases off a step, never below what ran short. Taking in a new
song doesn't count. It remembers what each device needed, in its own settings folder (its log says
where), so the next launch starts there; choosing exclusive mode again in the settings stands over a
share it fell back to.

The studio's **Lowest / Balanced / Safe** is a floor under all of that: Lowest lets it start at the
shortest period, Balanced starts at twice it, Safe at four times. Audio & MIDI settings show the depth
in use and why ("deepened after the device ran short", "remembered for this device").

The song plays on worker threads (the computer's cores but two, at most six: `--threads n` for another
number, `--threads 0` for one thread), which keep 85 ms ahead and go further when they fall behind, as
in the studio; who plays what is laid out by HO[LO] Engine itself, from the song as it arrives and from
how long each track and bus takes as it plays. ASIO isn't used: WASAPI exclusive mode reaches the same
few milliseconds on most devices with nothing to install.

**When something's off:**

- *A MIDI device says "in use by another app".* Windows lets one app at a time open most MIDI devices.
  Close the other one (a DAW, or a studio tab that opened the device itself before HO[LO] Engine
  started: reload it); HO[LO] Engine tries again every second.
- *The studio doesn't find it.* It looks when the page loads, whenever the window comes back to the
  front, and every little while after. From a public web address the browser asks first: press **Look
  for it** in Audio & MIDI settings and allow it. HO[LO] Engine lets in studios served from this
  computer, the local network or a tailnet; start it with `--origin https://your.address` for another.
  If the settings show no HO[LO] Engine section at all, the tab is running an older studio (the app
  keeps a copy of itself for offline use, and a tab opened before an update stays on it): reload it.
- *Another studio tab took it.* One studio at a time has HO[LO] Engine: the newest. Reload the tab you
  want to play in.
- *It says it's already running.* One HO[LO] Engine per computer.
- *Bluetooth headphones.* Their own radio link adds 100–250 ms, which no app can see or take away.
  HO[LO] Engine shares them (exclusive mode makes them stall and crackle) and the settings say so: to
  play, use the computer's speakers or wired headphones.
- *Crackles.* The settings say how often the device ran short and what HO[LO] Engine did about it: it
  keeps more in hand, opens the device at a longer period, and shares it as a last resort, by itself.
  A few shortfalls at the start are harmless; if they keep coming at the longest period, the computer
  can't keep up with the song: try a lighter song, or **Safe** as a floor. A USB audio device at its
  shortest period (3 ms on many) under a heavy song is the usual case: it's opened at twice or four
  times that after its first shortfall and remembered that way; the computer's built-in output, or
  wired headphones in its jack, usually hold their longer period from the start (see the table
  above). The DSP meter says
  which thread is the busy one: the render thread (the live notes and the master) or one of the
  threads the song plays on (a track or bus too heavy for one thread, which freezing would help).

## Recording audio in time

What you play into a microphone reaches HO[LO] late by the whole round trip: the song took the output's
time to reach your ears, and your playing takes the input's time to come back. HO[LO] moves every audio
recording back by that much, so it lands where you played it. It uses the round trip measured on this
device (**Measure with the microphone**) when there is one, and otherwise what the browser reports.
Measure again after changing the output, the input or the latency setting.

Input monitoring (the headphones button on an audio track) plays the input through the track and its
plugins, which adds that same round trip to what you hear. For singing or playing with no delay at
all, use your audio interface's own direct monitoring and leave HO[LO]'s off.

## One interface, two instruments

A MIDI interface with a keyboard and drum pads on it shows up as one or more ports. Give each track
its input in the Inspector (**MIDI in** and **Channel**): for example the keyboard track on channel 1
and the drums track on channel 10, which drum pads usually send. Arm both to record them together. With
nothing armed, live MIDI goes to the selected track.

## Devices on the network

Any HO[LO] page can send its MIDI to the studio that's open elsewhere: the server passes `midi`
messages from one device to every open studio. A phone running HO[LO]'s Play view does exactly that
for its touch keyboard and pads.

**HO[LO] Remote** (`/remote`, or scan the code behind the phone button in the studio) is made for the
device by your instruments: it starts no audio of its own, shows the studio's position and levels, and
sends its buttons, faders and notes to the studio it drives (choose one when several are open). Over a
tailnet or a local network a command takes a few milliseconds to arrive; the remote's notes are heard
as a network MIDI device, so play time-critical parts on an instrument plugged into the studio's own
computer, and use the remote's keys and pads for sketching.

### iPhone and iPad

No browser on an iPhone or iPad has Web MIDI (all of them use Safari's engine), so a keyboard plugged
into one can't reach HO[LO] through the browser. It can through Apple's own **network MIDI**
(RTP-MIDI), which HO[LO] answers:

1. On the host, let your devices reach it: `pnpm netmidi on` (your tailnet: the phone needs Tailscale
   on) or `pnpm netmidi lan` (your local network). It prints the address. (`pnpm netmidi off` closes it
   again; without Docker, set `HOLO_NETWORK_MIDI=on`.)
2. On the iPhone, plug the keyboard or pads in (a USB-C or Lightning to USB adapter), and in a MIDI app
   with network sessions (midimittr, for one) add a session at that address, port 5004, connect, and
   route the keyboard to it.
3. The studio hears it as a MIDI device named after the phone, like any other: arm a track, or select
   one, and play. **Audio & MIDI** settings shows who's connected.

A Mac can join the same way (Audio MIDI Setup → MIDI Studio → Network → Directory). The notes cross the
network, a few milliseconds on a tailnet or a home network; for the tightest timing, plug the keyboard
into the computer you're playing through instead. Pair it with **HO[LO] Remote** in the phone's browser
and the phone is both the keyboard's way in and the studio's remote control.
