export type Osc133Event = {
  code: "A" | "B" | "C" | "D";
  exitCode?: number;
};

/** Incrementally extracts OSC 133 sequences from arbitrary output chunking. */
export class Osc133Parser {
  private readonly decoder = new TextDecoder();
  private buffer = "";

  push(chunk: Uint8Array): Osc133Event[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.consume();
  }

  finish(): Osc133Event[] {
    this.buffer += this.decoder.decode();
    return this.consume();
  }

  private consume(): Osc133Event[] {
    const events: Osc133Event[] = [];
    for (;;) {
      const start = this.buffer.indexOf("\x1b]133;");
      if (start === -1) {
        this.buffer = this.partialMarkerSuffix();
        return events;
      }
      if (start > 0) this.buffer = this.buffer.slice(start);
      const payloadStart = "\x1b]133;".length;
      const bell = this.buffer.indexOf("\x07", payloadStart);
      const st = this.buffer.indexOf("\x1b\\", payloadStart);
      const end = bell === -1 ? st : st === -1 ? bell : Math.min(bell, st);
      if (end === -1) return events;
      const payload = this.buffer.slice(payloadStart, end);
      this.buffer = this.buffer.slice(end + (end === st ? 2 : 1));
      const [code, status] = payload.split(";", 2);
      if (code !== "A" && code !== "B" && code !== "C" && code !== "D") continue;
      const exitCode = code === "D" && status !== undefined && /^-?\d+$/.test(status)
        ? Number(status)
        : undefined;
      events.push({ code, ...(exitCode === undefined ? {} : { exitCode }) });
    }
  }

  private partialMarkerSuffix(): string {
    const marker = "\x1b]133;";
    const maximum = Math.min(marker.length - 1, this.buffer.length);
    for (let length = maximum; length > 0; length -= 1) {
      const suffix = this.buffer.slice(-length);
      if (marker.startsWith(suffix)) return suffix;
    }
    return "";
  }
}
