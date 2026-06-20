const frames = ["|", "/", "-", "\\"];

export function createProgress({ enabled = true } = {}) {
  return new Progress({ enabled });
}

class Progress {
  constructor({ enabled }) {
    this.enabled = Boolean(enabled && process.stdout.isTTY);
  }

  async step(label, task) {
    if (!this.enabled) return task();
    let frame = 0;
    process.stdout.write(`${frames[frame]} ${label}`);
    const timer = setInterval(() => {
      frame = (frame + 1) % frames.length;
      process.stdout.write(`\r${frames[frame]} ${label}`);
    }, 80);
    try {
      const result = await task();
      clearInterval(timer);
      process.stdout.write(`\r✓ ${label}\n`);
      return result;
    } catch (error) {
      clearInterval(timer);
      process.stdout.write(`\r✕ ${label}\n`);
      throw error;
    }
  }
}
