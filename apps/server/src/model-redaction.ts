import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/** Redact JSON string values in JSON/SSE without changing protocol field names. */
export function modelResponseRedaction(secrets: string[]) {
  const patterns = [...new Set(secrets.filter(Boolean).flatMap((secret) => [secret, encodeURIComponent(secret)]))].sort(
    (a, b) => b.length - a.length,
  );
  const clean = (value: string) => patterns.reduce((text, pattern) => text.split(pattern).join("[redacted]"), value);
  const decoder = new StringDecoder("utf8");
  let literal = "",
    whitespace = "",
    escaped = false,
    complete = false;
  const consume = (text: string, final = false) => {
    let output = "";
    const release = (key: boolean) => {
      if (key) output += literal;
      else {
        try {
          output += JSON.stringify(clean(JSON.parse(literal)));
        } catch {
          output += clean(literal);
        }
      }
      output += whitespace;
      literal = "";
      whitespace = "";
      complete = false;
    };
    for (const character of text) {
      if (complete) {
        if (/\s/.test(character)) {
          whitespace += character;
          continue;
        }
        release(character === ":");
      }
      if (literal) {
        literal += character;
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') complete = true;
      } else if (character === '"') {
        literal = character;
        escaped = false;
      } else output += character;
    }
    if (final && literal) release(false);
    return output;
  };
  return new Transform({
    transform(chunk, _encoding, callback) {
      callback(null, consume(decoder.write(chunk)));
    },
    flush(callback) {
      callback(null, consume(decoder.end(), true));
    },
  });
}
