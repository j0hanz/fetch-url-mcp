import { parentPort } from 'node:worker_threads';

import { transformHtmlToMarkdownInProcess } from '../transform.js';
import { createTransformMessageHandler } from './shared.js';

if (!parentPort) throw new Error('transform-worker started without parentPort');
const port = parentPort;

const onMessage = createTransformMessageHandler({
  sendMessage: (message) => {
    port.postMessage(message);
  },
  runTransform: transformHtmlToMarkdownInProcess,
});

port.on('message', onMessage);
