import { FrameError } from "./frame_error.ts";
import { decodeHeader, decodeMethod } from "./amqp_codec.ts";
import type { IncomingFrame } from "./amqp_frame.ts";
import type { Reader } from "@std/io/types";

export class AmqpFrameReader {
  #timer: null | number = null;
  #reader: Reader;

  constructor(r: Reader) {
    this.#reader = r;
  }

  #readBytes = async (length: number): Promise<Uint8Array> => {
    const buffer = new Uint8Array(length);
    const bytesRead = await this.#reader.read(buffer);

    if (bytesRead !== length) {
      if (bytesRead === null) {
        throw new FrameError("EOF");
      }

      // If we read less than expected, we need continue reading the rest of the bytes.
      let offset = bytesRead ?? 0;
      while (offset < length) {
        const bytes = await this.#reader.read(buffer.subarray(offset));
        if (bytes === null) {
          throw new FrameError(
            "EOF",
            `expected ${length} bytes, got ${offset} bytes`,
          );
        }
        offset += bytes;
      }
    }

    return buffer;
  };

  #readFrame = async (): Promise<IncomingFrame> => {
    const prefix = await this.#readBytes(7);

    const prefixView = new DataView(prefix.buffer);
    const type = prefixView.getUint8(0);
    const channel = prefixView.getUint16(1);
    const length = prefixView.getUint32(3);

    const rest = await this.#readBytes(length + 1);

    const endByte = rest[rest.length - 1];

    if (endByte !== 206) {
      throw new FrameError("BAD_FRAME", `unexpected FRAME_END '${endByte}'`);
    }

    const payload = rest.slice(0, rest.length - 1);

    if (type === 1) {
      return {
        type: "method",
        channel: channel,
        payload: decodeMethod(payload),
      };
    }

    if (type === 2) {
      return {
        type: "header",
        channel,
        payload: decodeHeader(payload),
      };
    }

    if (type === 3) {
      return {
        type: "content",
        channel,
        payload,
      };
    }

    if (type === 8) {
      return {
        type: "heartbeat",
        channel,
        payload,
      };
    }

    throw new FrameError("BAD_FRAME", `unexpected frame type '${type}'`);
  };

  abort() {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
    }
  }

  read(
    timeout: number,
  ): Promise<IncomingFrame> {
    this.abort();

    if (timeout <= 0) {
      return this.#readFrame();
    }

    const timeoutMessage = `server heartbeat timeout ${timeout}ms`;

    return new Promise<IncomingFrame>((resolve, reject) => {
      this.#timer = setTimeout(() => {
        reject(new Error(timeoutMessage));
      }, timeout);

      this.#readFrame()
        .then(resolve)
        .catch(reject)
        .finally(() => this.abort());
    });
  }
}
