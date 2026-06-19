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

  async askOptional(name, message, { defaultValue = "", secret = false } = {}) {
    const envValue = process.env[name];
    if (envValue) return envValue;
    if (this.yes) return defaultValue;
    const suffix = defaultValue ? ` (${defaultValue})` : "";
    const prompt = `${message}${suffix}: `;
    const answer = secret ? await this.askSecret(prompt) : await this.askVisible(prompt);
    return answer.trim() || defaultValue;
  }

  async confirm(name, message, { defaultValue = true } = {}) {
    const envValue = process.env[name];
    if (envValue) return !["0", "false", "no", "n"].includes(envValue.toLowerCase());
    if (this.yes) return defaultValue;
    const suffix = defaultValue ? "Y/n" : "y/N";
    const answer = (await this.askVisible(`${message} (${suffix}): `)).trim().toLowerCase();
    if (!answer) return defaultValue;
    return ["y", "yes", "true", "1"].includes(answer);
  }

  async select(name, message, choices, { defaultIndex = 0 } = {}) {
    if (!choices.length) throw new Error(`${message} has no choices.`);
    const envValue = process.env[name];
    if (envValue) {
      const byValue = choices.find((choice) => choice.value === envValue);
      if (byValue) return byValue;
      const byLabel = choices.find((choice) => choice.label.toLowerCase() === envValue.toLowerCase());
      if (byLabel) return byLabel;
    }
    if (this.yes) return choices[defaultIndex] || choices[0];
    output.write(`${message}:\n`);
    choices.forEach((choice, index) => output.write(`  ${index + 1}. ${choice.label}\n`));
    const answer = (await this.askVisible(`Choose ${defaultIndex + 1}: `)).trim();
    if (!answer) return choices[defaultIndex] || choices[0];
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && choices[index]) return choices[index];
    const byValue = choices.find((choice) => choice.value === answer);
    if (byValue) return byValue;
    throw new Error(`Invalid choice: ${answer}`);
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
