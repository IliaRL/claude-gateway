import Parser from 'stream-json/parser.js';
import StreamValues from 'stream-json/streamers/stream-values.js';
import Chain from 'stream-chain';
import logger from './logger.js';

/**
 * Streams and parses a JSON request body, allowing incremental processing.
 * @param {http.IncomingMessage} req - The HTTP request object.
 * @returns {Promise<Object>} - A promise that resolves with the parsed JSON.
 */
export function streamRequestBody(req) {
    return new Promise((resolve, reject) => {
        const pipeline = new Chain([
            req,
            new Parser(),
            new StreamValues()
        ]);

        let result = null;
        pipeline.on('data', data => {
            result = data.value;
        });

        pipeline.on('end', () => {
            if (result === null) {
                resolve({});
            } else {
                resolve(result);
            }
        });

        pipeline.on('error', err => {
            logger.error('[Stream JSON] Error parsing request body:', err);
            reject(new Error("Invalid JSON in request body."));
        });
    });
}

/**
 * Peeks at essential metadata (model, stream) from a streaming request body without buffering everything.
 * This is used for routing decisions.
 * @param {http.IncomingMessage} req - The HTTP request object.
 * @returns {Promise<Object>} - A promise that resolves with an object containing metadata.
 */
export function peekStreamingMetadata(req) {
    return new Promise((resolve) => {
        const parser = new Parser();
        const metadata = {
            model: null,
            stream: false
        };

        let modelFound = false;
        let streamFound = false;
        let currentKey = null;
        let resolved = false;

        const onToken = ({ name, value }) => {
            if (resolved) return;

            if (name === 'keyValue') {
                if (value === 'model') {
                    currentKey = 'model';
                } else if (value === 'stream') {
                    currentKey = 'stream';
                } else {
                    currentKey = null;
                }
            } else if (name === 'stringValue' && currentKey === 'model') {
                metadata.model = value;
                modelFound = true;
                currentKey = null;
            } else if ((name === 'booleanValue' || name === 'nullValue') && currentKey === 'stream') {
                metadata.stream = value === true;
                streamFound = true;
                currentKey = null;
            }

            if (modelFound && streamFound) {
                resolved = true;
                cleanup();
                resolve(metadata);
            }
        };

        const cleanup = () => {
            parser.removeListener('data', onToken);
            // We don't unpipe here because it might interfere with other consumers
            // if they are already attached or about to be.
            // stream-json Parser is a writable stream.
        };

        parser.on('data', onToken);

        parser.on('end', () => {
            if (!resolved) {
                resolved = true;
                cleanup();
                resolve(metadata);
            }
        });

        parser.on('error', () => {
            if (!resolved) {
                resolved = true;
                cleanup();
                resolve(metadata);
            }
        });

        req.pipe(parser);
    });
}
