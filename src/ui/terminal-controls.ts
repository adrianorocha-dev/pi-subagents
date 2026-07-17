const ESC = 0x1b;
const BEL = 0x07;
const CSI = 0x9b;
const ST = 0x9c;
const OSC = 0x9d;
const STRING_CONTROLS = new Set([0x90, 0x98, 0x9e, 0x9f]);

function consumeCsi(value: string, start: number): number {
  for (let index = start; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index;
  }
  return value.length - 1;
}

function consumeStringControl(value: string, start: number, bellTerminates: boolean): number {
  for (let index = start; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if ((bellTerminates && code === BEL) || code === ST) return index;
    if (code === ESC && value.charCodeAt(index + 1) === 0x5c) return index + 1;
  }
  return value.length - 1;
}

/** Remove terminal escape sequences and replace standalone C0/C1 controls. */
export function neutralizeTerminalControls(value: string, replacement = " "): string {
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);

    if (code === ESC) {
      const introducer = value.charCodeAt(index + 1);
      if (introducer === 0x5b) {
        index = consumeCsi(value, index + 2);
        continue;
      }
      if (introducer === 0x5d) {
        index = consumeStringControl(value, index + 2, true);
        continue;
      }
      if (introducer === 0x50 || introducer === 0x58 || introducer === 0x5e || introducer === 0x5f) {
        index = consumeStringControl(value, index + 2, false);
        continue;
      }
      if (Number.isNaN(introducer)) continue;

      // Consume a complete two-byte or intermediate ESC sequence.
      index++;
      while (index + 1 < value.length) {
        const sequenceCode = value.charCodeAt(index);
        if (sequenceCode < 0x20 || sequenceCode > 0x2f) break;
        index++;
      }
      continue;
    }

    if (code === CSI) {
      index = consumeCsi(value, index + 1);
      continue;
    }
    if (code === OSC) {
      index = consumeStringControl(value, index + 1, true);
      continue;
    }
    if (STRING_CONTROLS.has(code)) {
      index = consumeStringControl(value, index + 1, false);
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      result += replacement;
      continue;
    }
    result += value[index] ?? "";
  }
  return result;
}

/** Normalize untrusted labels to one printable line before applying theme ANSI. */
export function cleanUiText(value: string): string {
  return neutralizeTerminalControls(value).replaceAll(/\s+/gu, " ").trim();
}
