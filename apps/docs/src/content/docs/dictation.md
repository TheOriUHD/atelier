---
title: Dictation
description: "Speak instead of typing: the microphone in the message box turns your words into text as you say them, with a speech-to-text service of the providers already set up."
---

The microphone in the message box turns speech into text while you speak. The words appear where the cursor was, in
italics until you stop, and stay in the box to edit or send. Below the box a waveform moves with your voice.

It works in Chat and Code, in the desktop app and in a browser, in conversations and on the new-conversation
screen.

## Dictate

- **Click the microphone** to start, and click it again to stop. The words stay in the box.
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

The small arrow next to the microphone opens a menu:

- **Microphone**: the system's default, or any other input. The choice is kept on this computer.
- **Language**: **Auto** lets the service hear which language you speak. Choosing yours helps with short phrases and
  names. Type to search the list.
- **Hold to record**: whether holding the button or the shortcut records until you let go.

The same settings are in **Settings › General › Dictation**.

## Where the words come from

Atelier needs nothing extra for dictation: it uses a speech-to-text service of a provider an admin already added, under
**Settings › Admin › Providers** or **Media**. The sound goes from your window to your Atelier backend, which sends it to
that service with its key; the key never reaches your window.

| Provider | Service | How words appear |
|---|---|---|
| **Mistral** or **Mistral Vibe** (as a text provider), or **Mistral Voxtral** (Media) | Voxtral Realtime | While you speak, about half a second behind you |
| A local server under Media in OpenAI's format (**Speaches**, **LocalAI**, **KoboldCpp**, **vLLM-Omni**, **OpenAI-compatible speech**) with a speech-to-text model typed in, such as a Whisper model | That model | A phrase at a time |
| **OpenAI** (text or Media) | GPT-4o Transcribe, GPT-4o mini Transcribe | A phrase at a time |
| **Groq** (an OpenAI-compatible provider at `api.groq.com`, or Groq speech) | Whisper Large v3 Turbo | A phrase at a time |
| **Together AI** | Whisper Large v3 | A phrase at a time |
| **ElevenLabs** (Media) | Scribe v2 | A phrase at a time |
| **Deepgram Aura** (Media) | Nova-3 | A phrase at a time |

"A phrase at a time" services hear whole recordings. Atelier cuts your speech at its pauses and sends each phrase. While
you are still in the middle of one it sends what you have said so far again every second or two, so words appear as you
speak. Then it sends the whole phrase once more for the final text. Silence is never sent. That re-sending is billed as
audio by the service, so a live service such as Voxtral Realtime costs less for the same speech.

With several, Atelier takes a live one first, then a local server, then the others in the order above. An admin can
choose one in **Settings › General › Dictation › Speech-to-text service**, or turn dictation off for everyone there.
Without any, admins still see the microphone, which says how to add a service; others don't see it.

## Allowing the microphone

- **macOS**: the first time you dictate, macOS asks whether Atelier may use the microphone. If you said no, allow it in
  **System Settings › Privacy & Security › Microphone**. The message under the box links there.
- **Windows**: microphone access for desktop apps is in **Settings › Privacy & security › Microphone**.
- **In a browser**: the browser asks for the page. It only lets a secure page use the microphone: open Atelier over
  https, or at `localhost` on the computer it runs on. A server reached at a plain `http://` address on your network
  can't take dictation in a browser; the desktop app can.

## What leaves your computer

Only while you dictate, the sound goes to your Atelier backend and from there to the speech-to-text service. Atelier
keeps neither the sound nor a transcript apart from what you send. The service's own terms say what it keeps.
