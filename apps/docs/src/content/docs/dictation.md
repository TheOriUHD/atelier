---
title: Dictation
description: "Speak instead of typing: the microphone in the message box turns your words into text as you say them, on your own computer or your own server, with nothing to set up."
---

The microphone at the right end of the message box turns speech into text while you speak. The words appear where the cursor was, in
italics until you stop, and stay in the box to edit or send. Below the box a waveform moves with your voice.

It works in Chat and Code, in the desktop app and in a browser, in conversations and on the new-conversation screen.
It needs no provider and no key.

## Dictate

- **Click the microphone** to start, and click it again to stop. The words stay in the box. If the last words are still
  on their way, a second click stops waiting for them.
- **Hold it** to record until you let go, with **Hold to record** on (it is by default). A quick click still starts and
  stops.
- **⇧⌘Space** (Ctrl+Shift+Space on Windows and Linux) does the same from the keyboard: press it to start and stop, or
  hold it while you speak. You can change it in **Settings › Shortcuts**.
- **Enter** stops and sends the message with what you said.
- **Esc** stops and throws away what you said; the message is as it was.
- **Typing** stops dictating and goes on from the end of the words.

Text you select before you start is replaced by what you say. Dictation stops by itself after ten minutes, or when the
microphone goes away.

## Microphone, language and Hold to record

Right-click the microphone (or press the context-menu key while it has the focus) for a menu:

- **Microphone**: the system's default, or any other input. The choice is kept on this computer.
- **Language**: **Auto** hears which language you speak. Choosing yours helps with short phrases and names. Type to
  search the list.
- **Hold to record**: whether holding the button or the shortcut records until you let go.

The same settings are in **Settings › General › Dictation**.

## Where your words are turned into text

**On a Mac** (the desktop app, macOS 26 or later), the Mac's own speech recognition does it, the one behind Notes and
Voice Memos. Nothing leaves the Mac, and Atelier downloads nothing for it; the first time you dictate in a language the
Mac doesn't have yet, macOS fetches it. It knows English, German, French, Spanish, Italian, Portuguese, Chinese,
Japanese, Korean, Hindi and other Indian languages. For any other language Atelier's speech model takes over by itself.

**Everywhere else** (a browser, the desktop app on Windows and Linux, a Mac with the developer option below),
**Atelier's own speech model** does it: NVIDIA's [Nemotron 3.5 ASR](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b),
run by [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx). Words appear while you speak, with punctuation, in about
30 languages: English, German, French, Spanish, Italian, Portuguese, Dutch, Polish, Swedish, Danish, Norwegian,
Finnish, Czech, Slovak, Hungarian, Romanian, Bulgarian, Croatian, Estonian, Turkish, Russian, Ukrainian, Arabic, Hindi,
Chinese, Japanese, Korean and Vietnamese.

- It runs where your Atelier backend runs: **on the server** for everyone connected to one, or **on your computer**
  when the desktop app runs on its own (Run on this computer).
- The first time someone dictates there, the backend downloads it: the model from Hugging Face and its engine from npm,
  about 715 MB, checked against fixed checksums. The message box shows how far it got. After that it works without the
  internet. Admins can download it ahead of time under **Settings › General › Dictation**.
- It needs no graphics card. On a recent processor it hears about ten times faster than you speak, and it holds about
  700 MB of memory while someone dictates (it lets go after a quarter of an hour without dictation).

**Developer option (Mac):** **Settings › Developer › Dictate with Atelier's speech model on this Mac** makes this Mac use
Atelier's model too: the server's when you are connected to one.

## Using a provider instead

Admins can choose a speech-to-text service of a provider already set up, under **Settings › General › Dictation ›
Speech-to-text service**, in place of Atelier's model (a Mac keeps its own recognition):

| Provider | Service | How words appear |
|---|---|---|
| **Mistral** or **Mistral Vibe** (as a text provider), or **Mistral Voxtral** (Media) | Voxtral Realtime | While you speak |
| A local server under Media in OpenAI's format (**Speaches**, **LocalAI**, **KoboldCpp**, **vLLM-Omni**, **OpenAI-compatible speech**) with a speech-to-text model typed in, such as a Whisper model | That model | A phrase at a time |
| **OpenAI** (text or Media) | GPT-4o Transcribe, GPT-4o mini Transcribe | A phrase at a time |
| **Groq** (an OpenAI-compatible provider at `api.groq.com`, or Groq speech) | Whisper Large v3 Turbo | A phrase at a time |
| **Together AI** | Whisper Large v3 | A phrase at a time |
| **ElevenLabs** (Media) | Scribe v2 | A phrase at a time |
| **Deepgram Aura** (Media) | Nova-3 | A phrase at a time |

"A phrase at a time" services hear whole recordings. Atelier cuts your speech at its pauses and sends each phrase. While
you are still in the middle of one it sends what you have said so far again every second or two, so words appear as you
speak. Then it sends the whole phrase once more for the final text. Silence is never sent. That re-sending is billed as
audio by the service.

The same place turns dictation off for everyone.

## Allowing the microphone

- **macOS**: the first time you dictate, macOS asks whether Atelier may use the microphone. If you said no, allow it in
  **System Settings › Privacy & Security › Microphone**. The message above the box links there.
- **Windows**: microphone access for desktop apps is in **Settings › Privacy & security › Microphone**.
- **In a browser**: the browser asks for the page. It only lets a secure page use the microphone: open Atelier over
  https, or at `localhost` on the computer it runs on. A server reached at a plain `http://` address on your network
  can't take dictation in a browser; the desktop app can.

## What leaves your computer

Only while you dictate. On a Mac with its own recognition, nothing leaves it. Otherwise the sound goes from your window
to your Atelier backend, which turns it into text itself, or, if an admin chose a provider, sends it on to that
service. Atelier keeps neither the sound nor a transcript apart from what you send.
