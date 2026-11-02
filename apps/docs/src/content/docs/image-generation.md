---
title: Image generation
description: Add image providers such as ComfyUI, Forge, OpenAI or Google, and any text model can make images and show them in the conversation, edit them when you ask, and save them to your folder.
---

Add an image provider, and the assistant can make images in Chat, Code and Cowork. You ask in your own words, the text
model writes the prompt, and the image appears in the conversation while you watch it being made. Ask for a change and
the model edits that image. In Code and Cowork it can save an image into your folder.

Image providers are separate from the [text providers](/providers/). A text model calls the image model as a tool, so it
works with any text model that can call tools, local ones included. Nothing changes until you add one: without an image
provider, Atelier sends models exactly what it sent before.

## Add an image provider

Open **Settings › Admin › Image providers**. Servers running on this computer on their usual port show under **Found on
this computer**, one click from added. **Add** lists every service.

After you add one, **Test** checks that it answers and lists its models. **Make a test image** makes one small real
image. It's a separate button because on a paid service it costs money.

On a server with several accounts, each person can also use an image server on their own computer: open **Settings › Your
models** in the desktop app, and it works from sessions on the server while that computer is online.

### Local and self-hosted

| Service | Notes |
|---|---|
| **ComfyUI** | Your checkpoints appear as models with no setup, and you can import your own workflows. Shows the picture forming as it works. |
| **Forge**, **AUTOMATIC1111**, **SD.Next**, **reForge** | Start them with `--api`. |
| **SwarmUI** | |
| **InvokeAI** | |
| **Draw Things** | Turn on the API Server in the app, with HTTP as the protocol. |
| **KoboldCpp** | Start it with an image model loaded. |
| **stable-diffusion.cpp** | Use its `sd-server` program. |
| **LocalAI** | |
| **Ollama** | Image models in Ollama are experimental. |

:::caution
ComfyUI and most of these servers have no sign-in. Anyone who can reach the port can use the GPU, so keep them on a network
you trust.
:::

### Cloud

**OpenAI**, **Google Gemini**, **Vertex AI**, **Black Forest Labs**, **Stability AI**, **xAI**, **Ideogram**, **Recraft**,
**Azure OpenAI** and **Amazon Bedrock** connect with a key. If you've added OpenAI as a text provider, **Use the key from
OpenAI** saves pasting it again.

- **ChatGPT Plan** uses the ChatGPT Plan you've already signed in to, and your plan's limits. OpenAI doesn't document this
  route, so it may stop working or not be open to every plan.
- **Amazon Bedrock** takes a Bedrock API key, or `ACCESS_KEY:SECRET` with an optional `:SESSION_TOKEN`. It offers Stability's
  models, in `us-west-2`.
- **Vertex AI** uses express mode, and you type in the model ids.

**OpenRouter**, **fal.ai**, **Replicate**, **Together AI** and **Hugging Face** give you many models with one key. For
services that don't list their models, type the model ids in the form. On Hugging Face an id can name a provider, as in
`org/model:replicate`.

Any other server with `/v1/images/generations`, such as LiteLLM, works as **OpenAI-compatible images**.

## Make an image

Ask for it: "make a poster for the summer party, in a retro style". The text model turns that into a full prompt and picks
a size. A frame in the final shape appears straight away and says what's happening, such as how many jobs are ahead of
yours, or "Step 12 of 28".

When it's done, click the image to see it bigger and zoom in. Point at it for **Copy**, **Download**, **Use as reference**
and **Details**, which shows the model, size, seed, time and cost. **Images** in the sidebar has everything you've made,
and you can search it by prompt.

- **Change an image.** Say what to change: "make the sky darker". This works on images you attach, too. The model needs an
  image model that can edit; if the one in use can't, it says so.
- **Save it.** In Code and Cowork, ask: "put it in public/hero.png". That's a file change like any other: it follows your
  permissions, shows in Cowork's output files, and Rewind undoes it.
- **Choose the model.** Set your default in **Settings › General**, or pick one for this conversation from the **+** menu
  under **Image model**. You can also just name one when you ask.

Text models that can't see images can still make them: they get the image's id instead of the picture, so they can
still ask for changes.

## Permissions

Making an image touches nothing but the image provider, so it doesn't interrupt you. Chat, Auto and Bypass run it
without asking, and each turn can make at most 8 images, so text on a web page can't run up a bill. Ask mode asks first,
and Plan mode doesn't make images. Saving to your folder is a file edit and follows [your permissions](/permissions/).

## One GPU for text and images

A local image model and a local text model usually can't sit in the GPU's memory at once. If your image server shares a
GPU with a local text provider, set **Shares a GPU with** on the image provider:

- An image job waits its turn in the same queue as your text requests, and nothing else runs on that server meanwhile.
- The text model is unloaded first, so the image model has the memory.
- With **Unload after each image**, the image model leaves too, so the next text request has room.

The text model reloads for the next reply, which takes as long as loading it always does. Turn it off if your GPU can
hold both.

## Your own ComfyUI workflows

Open the ComfyUI provider's **Workflows**. Paste a workflow exported with **Save (API)**, or drop a PNG made by ComfyUI,
which carries its workflow. Atelier finds the prompt, seed, steps, size and input image, and shows you what it found so you
can correct it. The workflow then appears as an image model.

ComfyUI's ordinary **Save** writes a format meant for its own editor, which can't run as it is. Use **Save (API)** instead.

## Costs and limits

**Settings › Usage** shows images and what they cost. A cost a service reports is exact; otherwise it comes from a list of
prices and shows as an estimate. You can set your own price per model.

Admins can set limits under **Settings › Admin › Image providers**: images per turn, and images or spending per person per
day. They can also hide a model from other accounts, which stops anyone else using it, even by name.

## Where images are kept

A generated image is stored like an attachment, with its conversation. Deleting the conversation deletes it. Images from a
temporary chat stay out of the **Images** page. Exporting your data includes them. See [Data and files](/data-and-files/).

Prompts and input images go to the image provider you chose. Images keep whatever the provider puts in them: ComfyUI writes
the workflow into its PNGs, and some cloud services add a content credential.

## If something goes wrong

| What you see | What to do |
|---|---|
| **Start it with --api** | Forge and AUTOMATIC1111 only answer requests with that flag. |
| **Missing model** | The workflow names a file that isn't on the server. |
| The GPU ran out of memory | Close other models, set **Shares a GPU with**, or use a smaller size. |
| The provider refused the prompt | That's the provider's filter, and it's final. The assistant won't reword it to get past it. A blurred or filtered image counts as refused, and isn't kept. |
| No previews on a personal image server | Update the desktop app. |
