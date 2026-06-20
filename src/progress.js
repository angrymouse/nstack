const frames = ["|", "/", "-", "\\"];

export function createProgress({ enabled = true } = {}) {
  return new Progress({ enabled });
}

class Progress {
  constructor({ enabled }) {
    this.enabled = Boolean(enabled && process.stdout.isTTY);
  }

  async step(label, task, options = {}) {
    if (!this.enabled) return task();
    if (options.allowOutput) {
      process.stdout.write(`${label}...\n`);
      try {
        const result = await task();
        process.stdout.write(`✓ ${label}\n`);
        return result;
      } catch (error) {
        process.stdout.write(`✕ ${label}\n`);
        throw error;
      }
    }

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
