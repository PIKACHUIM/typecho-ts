export class PhpError extends Error {
  constructor(
    message: string,
    public readonly phpType: 'fatal' | 'warning' | 'notice' = 'fatal',
    public readonly file?: string,
    public readonly line?: number
  ) {
    super(file ? `${message} in ${file}:${line ?? 0}` : message);
    this.name = 'PhpError';
  }
}

/** Thrown by `exit` / `die`. */
export class TerminateSignal extends Error {
  constructor(public readonly state: unknown = null) {
    super('PHP exit');
    this.name = 'TerminateSignal';
  }
}

/** Thrown by `throw $e`, carries the PHP value as-is. */
export class PhpThrown extends Error {
  constructor(public readonly value: unknown) {
    super('PHP exception');
    this.name = 'PhpThrown';
  }
}

export class PhpBreakSignal extends Error {
  constructor(public readonly level: number = 1) {
    super('break');
  }
}

export class PhpContinueSignal extends Error {
  constructor(public readonly level: number = 1) {
    super('continue');
  }
}

export class PhpReturnSignal extends Error {
  constructor(public readonly value: unknown) {
    super('return');
  }
}

export class UnsupportedSyntax extends PhpError {
  constructor(nodeKind: string) {
    super(`Unsupported PHP syntax: ${nodeKind}`, 'fatal');
    this.name = 'UnsupportedSyntax';
  }
}
