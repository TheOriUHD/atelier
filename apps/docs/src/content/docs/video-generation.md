---
title: Video generation
description: Add a video service such as OpenRouter, xAI, fal.ai or your own ComfyUI, and any text model can make short clips, start them from a picture, and show them in the conversation.
---

Add a video provider, and the assistant can make short video clips in Chat, Code and Cowork. You ask for a clip, the text
model writes the prompt, and a frame in the clip's shape appears at once and says what it is waiting for. When the clip is
done it plays right there. Ask for a clip that starts from a picture, and the model starts from it.

Video uses the same machinery as [image generation](/image-generation/): the same providers page, the same permissions,
the same way of storing what comes back. This page is what differs. Nothing changes until you add a video provider.

:::note
A clip takes minutes and costs real money, far more than an image. Atelier keeps to two clips per turn unless an admin says
otherwise, never retries a failed clip by itself (a second job would be billed again), and asks you first in Ask mode.
:::

## Add a video provider

Open **Settings › Admin › Image & video**. **Add** lists every service; the video ones say so in their name. A service that
makes both pictures and clips (ComfyUI and SwarmUI) is one provider, and its video models appear among its models.

**Test** checks that the service answers and lists its models. It doesn't make a test clip: that would cost money and take
minutes, so the first clip is the one you ask for in a chat.

| Service | Notes |
|---|---|
| **OpenRouter video** | Veo, Kling, Wan, Seedance, Grok Imagine, Hailuo and others through one key, listed from OpenRouter's own video list with the lengths, resolutions and ratios each takes. It reports what each clip cost. It has no way to cancel, so stopping stops waiting, and the job may still be billed. |
| **xAI video** | Grok Imagine Video 1.5, its Lite model and the classic one. Starts from a picture. Reports the cost. No cancel either. |
| **fal.ai video** | fal's text-to-video and image-to-video endpoints, each read from its own published schema, so lengths, resolutions and the names of its inputs come from fal and not from a table in Atelier. Type in any other video endpoint by its id. |
| **Replicate video** | Video models by `owner/name`, read the same way from each model's schema. A picture is reduced to fit what Replicate takes inline. |
| **Black Forest Labs video** | FLUX 3 video, text to video and from a picture. |
| **Google Gemini video** | Gemini Omni. It makes the clip in one request, which can take minutes, and takes no length: the model chooses it. It always makes sound. |
| **ComfyUI** | Import a workflow that saves with **SaveVideo**, **SaveWEBM** or **VHS Video Combine** as MP4 or WebM. See below. |
| **SwarmUI** | Video models are recognised by their class, text to video and from a picture. Written from SwarmUI's source and not yet tried against a real server with a video model. |

### Not here, and why

- **OpenAI Sora.** OpenAI shut the Sora models and the Videos API down on 24 September 2026.
- **Google Veo through a Gemini key.** The Veo models on the Gemini API are shut down (the previews on 22 October 2026, the
  older ones before). The generally available Veo models are on Google Cloud, which signs in another way than an API key.
  Gemini Omni, above, is what the Gemini API offers now.
- **Animated WebP and PNG from ComfyUI.** These are pictures, not video files, so a workflow that ends in them isn't offered
  as a video model.

## Make a video

Ask for it: "a slow drive along the coast at dusk, 5 seconds, vertical". The text model turns that into a prompt and picks
a length, a ratio and a resolution from what the model offers. A video model can be asked for:

- a **length** (`seconds`), fitted to what the model makes: asked for 9 seconds from a model that makes 4, 6 or 8, you get 8
  and the model is told;
- an **aspect ratio** and a **resolution** such as `720p`; the default is the smallest that is at least 720p, because each
  step up costs more;
- **sound**, off unless you ask, on models that can switch it;
- a **first frame**, and on some models a **last frame**, from a picture in the conversation: say "animate this" with an
  attached or generated image;
- a **seed**, a **negative prompt** and a **frame rate**, on models that take them.

What a model can't do is left out and the assistant is told, so one request works on every service. A model that makes
video only from a picture says so, before anything is sent or counted.

While it works, the frame has its final shape from the first moment, with one line saying what it waits for ("2 ahead of you",
"Waiting in line", "Making a 5 s video", a percentage where the service gives one). A model you stop is stopped on the service
too where the service allows it.

When it's done the clip plays in the same frame, in the browser's own player: play, seek, volume and full screen work with a
pointer, touch and the keyboard. It starts muted and loops, and plays by itself only when it arrives while you watch and you
haven't asked for less motion. Point at it for **Open larger**, **Download**, **Use first frame as reference** and **Details**.
**Use first frame as reference** puts the clip's first picture in the message box, to continue from it.

**Images** in the sidebar has clips too, with a play mark and their length. **All / Images / Videos** filters it. There's no
"copy link": a link to a stored file only works for someone signed in.

## Permissions and limits

Making a video touches nothing but the provider, so Chat, Auto and Bypass run it without asking, Ask mode asks first, and
Plan mode doesn't make videos. Each turn can make at most 2 (an admin can change it from 1 to 20). Admins can also limit
videos and spending per person per day under **Settings › Admin › Image & video**; those limits are separate from the ones for
images. **Let models make videos** switches the tool off without touching images.

In Code and Cowork the assistant can save a clip to your folder with **SaveVideo**. It's a file change like any other: it
follows your permissions, shows among Cowork's output files, and Rewind undoes it. The file's name must match what it is
(`.mp4` or `.webm`).

A sub-agent never gets the video tool, because its clip wouldn't show in the conversation it works for.

## Costs

**Settings › Usage** counts videos, the seconds of video and what they cost, apart from tokens and images. A cost a service
reports (OpenRouter and xAI do) is exact. Otherwise it comes from a short list of per-second prices read from the vendors' own
pages, shown as an estimate, or from a price you set for the model. A model with no price shows no cost.

## Your own ComfyUI workflows

A video model file on your ComfyUI server isn't listed by itself: there are many ways to build the graph, and Atelier only
runs one it has seen working. Bring the graph: open the provider's **Workflows**, paste a workflow exported with **Save (API)**
(or a PNG or JSON file) that ends in **SaveVideo**, **SaveWEBM** or **VHS Video Combine**, with MP4 or WebM as its format.

Atelier finds the prompt, the seed, the size, the number of frames and the frame rate, and the picture loaders. The loader
behind a node's `start_image` is the first frame, and the one behind `end_image` the last. A workflow with a picture loader
is offered as a model that needs a picture. A length asked for becomes frames in the counts the family makes (a multiple of 4
plus 1 for Wan and Hunyuan, of 8 plus 1 for LTX-V, of 6 plus 1 for Mochi).

ComfyUI has no node that keeps a video in its temp folder, so unlike images, a clip is also left in ComfyUI's output folder.

## Where videos are kept

A video is stored like an attachment, with its conversation, and appears in your data export as a file. Deleting the
conversation deletes it. Videos from a temporary chat stay out of the **Images** page. A clip can be up to 512 MB; the
container is checked for what it really is, so a service's error page is never stored as a video. See
[Data and files](/data-and-files/).

Prompts and the pictures you start from go to the provider you chose.

## If something goes wrong

| What you see | What to do |
|---|---|
| **No video model is available** | An admin adds a video provider under **Settings › Admin › Image & video**. |
| **makes video only from a picture** | Attach or generate a picture first, then ask to animate it. |
| The provider refused the prompt | That's the provider's filter, and it's final. The assistant won't reword it to get past it. |
| **isn't an MP4 or WebM** | The service sent back something else. Atelier only keeps those two containers. |
| **sent nothing for too long** | The service went quiet for 15 minutes. A clip that takes over an hour is stopped. |
| A clip plays nowhere but the download works | The browser can't play that codec, such as H.265 in some browsers. Download it. |
