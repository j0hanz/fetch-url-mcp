import process from 'node:process';

import { transformHtmlToMarkdownInProcess } from '../transform.js';
import type { TransformWorkerOutgoingMessage } from '../types.js';
import { createTransformMessageHandler } from './shared.js';

const send = process.send?.bind(process);
if (!send) throw new Error('transform-child started without IPC channel');
const sendMessage = send as (message: unknown) => void;

function postMessage(message: TransformWorkerOutgoingMessage): void {
  sendMessage(message);
}

const onMessage = createTransformMessageHandler({
  sendMessage: postMessage,
  runTransform: transformHtmlToMarkdownInProcess,
});

process.on('message', onMessage);
