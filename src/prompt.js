import readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";

export class Prompter {
  constructor({ yes = false } = {}) {
    this.yes = yes || isCi() || input.isTTY !== true;
    this.rl = null;
  }

  async ask(name, message, { defaultValue = "", secret = false } = {}) {
    const envValue = process.env[name];
    if (envValue) return envValue;
    if (this.yes) {
      if (defaultValue !== "") return defaultValue;
      throw new Error(`Missing required value ${name}; pass --${dash(name)} or set ${name}.`);
    }
    const suffix = defaultValue ? ` (${defaultValue})` : "";
    const prompt = `${message}${suffix}: `;
    const answer = secret ? await this.askSecret(prompt) : await this.askVisible(prompt);
    const value = answer.trim() || defaultValue;
    if (!value) throw new Error(`${message} is required.`);
    return value;
  }

  askVisible(prompt) {
    if (!this.rl) this.rl = readline.createInterface({ input, output });
    return new Promise((resolve) => this.rl.question(prompt, resolve));
  }

  askSecret(prompt) {
    this.close();
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input, output, terminal: true });
      rl._writeToOutput = (text) => {
        if (text === prompt) output.write(text);
      };
      rl.question(prompt, (answer) => {
        rl.close();
        output.write("\n");
        resolve(answer);
      });
    });
  }

  close() {
    this.rl?.close();
    this.rl = null;
  }
}

function dash(name) {
  return name.toLowerCase().replaceAll("_", "-");
}

function isCi() {
  const value = process.env.CI;
  return Boolean(value && value !== "0" && value.toLowerCase() !== "false");
}
