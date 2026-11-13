---
title: Audio generation
description: Add a sound service such as ElevenLabs, OpenAI, Google Gemini, Kokoro or your own ComfyUI, and any text model can read text aloud, make music and sound effects, and play them in the conversation.
---

Add an audio provider, and the assistant can make sounds in Chat and Code: **speech** read aloud in a voice,
**music** with or without vocals, and **sound effects**. You ask for it, the text model writes exactly what is said or
describes the music, and a card holds its place in the conversation while it's made. When it's done it plays right there,
with its waveform to seek on.

Audio uses the same machinery as [image generation](/image-generation/) and [video generation](/video-generation/): the
same providers page, the same permissions, the same way of storing what comes back. This page is what differs. Nothing
changes until you add an audio provider.

## Add an audio provider

Open **Settings › Admin › Media**. **Add** lists every service; the audio ones say so in their name where the same service
also makes pictures. Servers on this computer on their usual port show under **Found on this computer**: Kokoro-FastAPI,
Speaches, LocalAI, KoboldCpp with a speech model, Chatterbox, Ollama with a speech model, Fish Speech and ACE-Step.

**Test connection** lists the models and their voices. **Make a test sound** then makes one sentence, or a few seconds of
music, and plays it. On a paid service that's a real request, so it's a button you press.

### Speech

| Service | Notes |
|---|---|
| **OpenAI speech** | GPT-4o mini TTS takes directions for how to speak ("calm, a slight smile"); TTS-1 and TTS-1 HD don't. 13 voices. OpenAI retires these models on 6 January 2027. |
| **ElevenLabs** | Every speech model your account has, with your voices, cloned ones included, read from your account. v3 and later follow audio tags such as `[whispers]`, which is how a direction reaches them. |
| **Google Gemini audio** | Gemini's speech models with 30 voices, each with Google's word for it ("firm", "warm"), and a conversation between two speakers in one request. |
| **xAI speech** | Grok's voices, listed for you, with its own tags such as `[laugh]`. |
| **Mistral Voxtral**, **Cartesia**, **Deepgram Aura**, **Fish Audio**, **MiniMax speech** | Each with the voices of your account. Deepgram's voice is part of its model name; Atelier lists them as voices. |
| **Groq speech** | Orpheus, in English and Saudi Arabic. It reads at most 200 characters at once, so long text is split by the assistant. |
| **Azure OpenAI speech** | Add each speech deployment by name as a model. |
| **OpenRouter speech**, **Together AI speech** | Speech models from many vendors through one key. OpenRouter lists each model with its own voices; its Google and Fish models take two speakers. |
| **Kokoro-FastAPI**, **Speaches**, **LocalAI**, **KoboldCpp**, **Chatterbox**, **Ollama**, **vLLM-Omni** | Servers on your own computer that speak OpenAI's format. Their voices come from the server. Kokoro's voices can be mixed, like `af_bella+af_sky`. |
| **OpenAI-compatible speech** | Any other server with `/v1/audio/speech`, such as LiteLLM. |

If you've added OpenAI, Mistral or OpenRouter as a text provider, **Use the key from …** on **OpenAI speech**, **Mistral
Voxtral** or **OpenRouter speech** saves pasting it again. For Voxtral that is a **Mistral** provider at `api.mistral.ai`;
a Mistral Vibe key isn't offered.

### Music and sound effects

| Service | Notes |
|---|---|
| **ElevenLabs** | Eleven Music, from 3 seconds to 10 minutes, with vocals or as an instrumental, and sound effects up to 30 seconds. Music needs a paid plan. |
| **Google Gemini audio** | Lyria 3.5 makes songs of a couple of minutes with vocals and the lyrics you give; Lyria 3 Clip makes 30 seconds. Lyria takes its settings in words, so Atelier writes the length and "instrumental only" into the prompt. Lyria marks every sound with Google's SynthID watermark. |
| **Stability AI audio** | Stable Audio 3 and 2.5: music and sound effects without vocals, up to about six minutes. |
| **fal.ai audio**, **Replicate audio** | Their speech, music and sound models, each read from its own published schema, so the voices, lengths and inputs come from the service and not from a table in Atelier. Type in any other endpoint by its id. |
| **ACE-Step 1.5** | Songs with vocals from lyrics, or instrumentals, on your own computer. |
| **LocalAI** | Music and effects from the models it serves for that, such as ACE-Step, MusicGen or Stable Audio. |
| **ComfyUI** | Stable Audio Open and ACE-Step 1.0 checkpoints are offered by themselves; any other sound model through a workflow. See below. |

### Not here, and why

- **Suno and Udio.** Neither has a public API; the services that offer one are unofficial wrappers.
- **Hume.** Hume shuts its speech API down on 13 November 2026.
- **MiniMax music.** It takes no new accounts. MiniMax's speech is here.
- **Voice cloning.** A voice you cloned in a service's own app shows among that service's voices and can be used. The
  assistant can't make a new voice from a recording.

## Make a sound

Ask for it: "read this paragraph aloud in a calm British voice", "a 30-second lofi beat to study to", "the sound of a door
creaking open in an empty hall". The assistant picks the kind, the model that makes it and, for speech, a voice that suits
what is said. What it can ask for:

- **speech**: the exact words, a **voice** from the model's list, a **direction** for how to say it on models that take one,
  a **speed**, and a **conversation** between two speakers on models that take several, each with their own voice;
- **music**: a description of the style, mood, tempo and instruments, **lyrics** on models that sing, an **instrumental**,
  and a **length**, fitted to what the model makes;
- **sound effects**: a description and a length;
- a **seed** and a **negative prompt**, on models that take them.

What a model can't do is left out and the assistant is told. Text longer than a model reads at once is refused before
anything is sent, and the assistant splits it.

While it works, the card shows a calm made-up waveform and one line saying what it waits for ("Waiting in line", "Loading the
model", "Making the speech", "Step 10 of 50" from ComfyUI). When it's done, the sound's own waveform takes its place. Click
or drag on it to seek; with the keyboard, the arrows move five seconds and Home and End go to the ends. Speech has a speed
button (1×, 1.25×, 1.5×, 2×, 0.75×). A sound never plays by itself, and starting one stops any other. **Download** and
**Details** are on the card; the details show the model, the voice, the length, the time it took, the cost, and the text,
direction or lyrics.

**Images** in the sidebar lists sounds too, with their kind, voice and words. **Sounds** filters to them; a sound opens with
its player and the way back to its conversation.

## Choosing models

Each kind has its own default: **Settings › General** has your default speech, music and sound effects models, and
**Settings › Admin › Media** the server's. A row appears once some model makes that kind. A model's **Description and
tuning…** sets its usual voice and, for music and effects, its usual length.

## Permissions and limits

Making a sound touches nothing but the provider, so Chat, Auto and Bypass run it without asking, Ask mode asks first and
shows the words it will say, and Plan mode doesn't make sounds. Each turn can make at most 6 sounds (an admin can change it
from 1 to 50), enough for a short conversation made line by line. Admins can also limit sounds and spending per person per
day; those limits are separate from the ones for images and video. **Let models make sounds** switches the tool off without
touching images or video.

In Code and in a chat with a folder the assistant can save a sound to the folder with **SaveAudio**. It's a file change
like any other: it follows your permissions, shows among a chat's output files, and Rewind undoes it in Code. The file's name must match what it is
(`.mp3`, `.wav`, `.ogg`, `.flac`, `.m4a`, `.aac` or `.webm`).

The assistant is told never to imitate a real person's voice or make speech that pretends to come from someone real, and
not to ask for an existing song or name a real artist: it describes the style and writes its own lyrics.

A sub-agent never gets the sound tool, because its sound wouldn't show in the conversation it works for.

## Costs

**Settings › Usage** counts sounds, their length, and for speech the characters read out, apart from tokens, images and
videos. A cost comes from a price you set for the model, or from a short list of prices read from the vendors' own pages,
shown as an estimate: OpenAI's TTS-1 and TTS-1 HD by the character, GPT-4o mini TTS by the second. Services billed by credits
or by plan, such as ElevenLabs, show no cost.

## Your own ComfyUI workflows

ComfyUI makes sound from Stable Audio Open, ACE-Step, YuE and MiniMax Music models. Stable Audio Open and ACE-Step 1.0
checkpoints are offered without setup when the server has the nodes and files they need (Stable Audio Open needs the
`t5_base` text encoder). A sound checkpoint is never taken for a picture model.

Any other sound model, ACE-Step 1.5 among them, comes in as a workflow: open the provider's **Workflows** and paste one
exported with **Save (API)** that ends in **SaveAudio**, **SaveAudioMP3**, **SaveAudioOpus**, **SaveAudioAdvanced** or
**PreviewAudio**. Atelier finds the prompt (ACE-Step's tags), the lyrics, the length on the empty audio latent, the seed and
the sampler settings, and keeps a length set in two places (Stable Audio's conditioning, ACE-Step 1.5's encoder) in step.
The save node is run as a preview, so nothing is left in ComfyUI's output folder.

## Where sounds are kept

A sound is stored like an attachment, with its conversation, and appears in your data export as a file. Deleting the
conversation deletes it. Sounds from a temporary chat stay out of the **Images** page. A sound can be up to 256 MB; the file
is checked for what it really is, so a service's error page is never stored as a sound. Raw samples some services send are
kept as WAV. See [Data and files](/data-and-files/).

The words and descriptions go to the provider you chose. A local server such as Kokoro or ComfyUI has no sign-in by default:
anyone who can reach it on your network can use it.

## If something goes wrong

| What you see | What to do |
|---|---|
| **No sound model is available** | An admin adds an audio provider under **Settings › Admin › Media**. |
| **No model here makes music** | The sound models here make other kinds. Add a provider that makes that kind. |
| **reads at most … characters at once** | The assistant splits the text into parts and makes each. |
| The provider refused it | That's the provider's filter, and it's final. The assistant won't reword it to get past it. |
| **isn't a sound file Atelier knows** | The service sent back something else. |
| **no voice was chosen, and this account has none** | Your ElevenLabs account lists no voices. Add one in ElevenLabs. |
