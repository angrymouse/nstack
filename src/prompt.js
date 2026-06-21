import { confirm, isCancel, password, select, text } from "@clack/prompts";
import { stdin as input, stdout as output } from "node:process";

export class Prompter {
  constructor({ yes = false } = {}) {
    this.yes = yes || isCi() || input.isTTY !== true;
  }

  async ask(name, message, { defaultValue = "", secret = false } = {}) {
    const envValue = process.env[name];
    if (envValue) return envValue;
    if (this.yes) {
      if (defaultValue !== "") return defaultValue;
      throw new Error(`Missing required value ${name}; pass --${dash(name)} or set ${name}.`);
    }
    const value = secret
      ? await this.askSecret(message, { required: true })
      : await this.askVisible(message, { defaultValue, required: true });
    if (!value) throw new Error(`${message} is required.`);
    return value;
  }

  async askOptional(name, message, { defaultValue = "", secret = false } = {}) {
    const envValue = process.env[name];
    if (envValue) return envValue;
    if (this.yes) return defaultValue;
    return secret
      ? await this.askSecret(message, { required: false })
      : await this.askVisible(message, { defaultValue, required: false });
  }

  async confirm(name, message, { defaultValue = true } = {}) {
    const envValue = process.env[name];
    if (envValue) return !["0", "false", "no", "n"].includes(envValue.toLowerCase());
    if (this.yes) return defaultValue;
    return this.handleCancel(await confirm({
      message,
      initialValue: defaultValue,
      input,
      output,
    }));
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
    const selectedValue = this.handleCancel(await select({
      message,
      options: choices.map((choice) => ({
        value: choice.value,
        label: choice.label,
        hint: choice.hint,
        disabled: choice.disabled,
      })),
      initialValue: (choices[defaultIndex] || choices[0]).value,
      input,
      output,
    }));
    return choices.find((choice) => choice.value === selectedValue) || choices[defaultIndex] || choices[0];
  }

  async askVisible(message, { defaultValue = "", required = true } = {}) {
    const answer = this.handleCancel(await text({
      message,
      placeholder: defaultValue || undefined,
      defaultValue: defaultValue || undefined,
      initialValue: defaultValue || undefined,
      validate(value) {
        if (required && !String(value || "").trim()) return `${message} is required.`;
        return undefined;
      },
      input,
      output,
    }));
    return String(answer || "").trim() || defaultValue;
  }

  async askSecret(message, { required = true } = {}) {
    const answer = this.handleCancel(await password({
      message,
      mask: "*",
      validate(value) {
        if (required && !String(value || "").trim()) return `${message} is required.`;
        return undefined;
      },
      input,
      output,
    }));
    return String(answer || "").trim();
  }

  handleCancel(value) {
    if (!isCancel(value)) return value;
    throw new Error("Prompt cancelled.");
  }

  close() {
    // Clack manages prompt lifecycle per prompt.
  }
}

function dash(name) {
  return name.toLowerCase().replaceAll("_", "-");
}

function isCi() {
  const value = process.env.CI;
  return Boolean(value && value !== "0" && value.toLowerCase() !== "false");
}
