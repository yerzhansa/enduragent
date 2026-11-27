export type ConditionalWriteResult<Current, Written> =
  | { readonly kind: "written"; readonly written: Written }
  | { readonly kind: "unchanged"; readonly current: Current }
  | { readonly kind: "changed"; readonly current: Current }
  | { readonly kind: "read-failed" }
  | { readonly kind: "write-failed"; readonly current: Current };

export interface ConditionalWrite<Current, Written> {
  read(): Promise<Current>;
  stillAsSeen(current: Current): boolean;
  alreadyWritten(current: Current): boolean;
  write(current: Current): Promise<Written>;
}

export async function writeIfUnchanged<Current, Written>(
  request: ConditionalWrite<Current, Written>,
): Promise<ConditionalWriteResult<Current, Written>> {
  let current: Current;
  try {
    current = await request.read();
  } catch {
    return { kind: "read-failed" };
  }
  if (request.alreadyWritten(current)) return { kind: "unchanged", current };
  if (!request.stillAsSeen(current)) return { kind: "changed", current };
  try {
    return { kind: "written", written: await request.write(current) };
  } catch {
    return { kind: "write-failed", current };
  }
}
