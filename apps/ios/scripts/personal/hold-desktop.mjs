// Signs a stand-in desktop app in as the admin of a throwaway server, adds one model server and one image server, and stays connected
// until it is killed (for the Swift integration test and for looking at "Your models" against a real server).
//   node hold-desktop.mjs [port]
import { connectFakeDesktop, TEXT_ID, IMAGE_ID, TEXT_BASE, IMAGE_BASE } from './fake-desktop.mjs';
const port = Number(process.argv[2] ?? 17420);
const desktop = await connectFakeDesktop(port, 'demo', 'atelier-demo-pass');
const text = await desktop.call('personalProviders.save', { id: TEXT_ID, type: 'ollama', name: 'Ollama on the MacBook', baseUrl: TEXT_BASE });
const image = await desktop.call('personalImageProviders.save', { id: IMAGE_ID, type: 'comfyui', preset: 'comfyui', name: 'ComfyUI', baseUrl: IMAGE_BASE });
console.log('HELD', text.error ? JSON.stringify(text.error) : 'text ok', image.error ? JSON.stringify(image.error) : 'image ok');
setInterval(() => {}, 1 << 30);
