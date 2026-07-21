export class RingBuffer {
  private lines: string[] = [];
  constructor(private capacity = 500) {}

  push(line: string): void {
    this.lines.push(line);
    if (this.lines.length > this.capacity) {
      this.lines.splice(0, this.lines.length - this.capacity);
    }
  }

  pushChunk(chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim().length > 0) this.push(line);
    }
  }

  toArray(): string[] {
    return [...this.lines];
  }

  clear(): void {
    this.lines = [];
  }
}
