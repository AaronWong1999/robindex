import assert from "node:assert/strict";

function stripToolCallDSL(text) {
  return String(text || "")
    .replace(/<\s*[｜|]?\s*DSML\s*[｜|]?\s*tool_calls\s*>\s*[\s\S]*?<\s*\/\s*[｜|]?\s*DSML\s*[｜|]?\s*tool_calls\s*>/gi, "")
    .replace(/<\s*[｜|]?\s*DSML\s*[｜|]?\s*\/?\s*tool_calls?\s*>\s*/gi, "")
    .replace(/<\s*\/?\s*(?:invoke|function|parameter|tool_calls?)\b[^>]*>\s*/gi, "")
    .replace(/^\s*[<＜]\s*[｜|]?\s*DSML\s*[｜|]?\s*(?:tool_calls?|invoke|parameter|function).*$/gim, "")
    .replace(/^\s*[<＜]\s*\/\s*[｜|]?\s*DSML\s*[｜|]?.*$/gim, "")
    .replace(/^\s*[<＜]\s*[｜|]?\s*(?:invoke|parameter|function|tool_calls?).*$/gim, "");
}

function createDSLStreamCleaner() {
  let pending = "";
  let inDslBlock = false;
  const MAX_PENDING = 512;
  const cleanComplete = (input) => {
    let text = input;
    let out = "";
    while (text) {
      if (inDslBlock) {
        const close = text.search(/<\s*\/\s*[｜|]?\s*DSML\s*[｜|]?\s*tool_calls\s*>/i);
        if (close < 0) return out;
        const rest = text.slice(close);
        const closeMatch = rest.match(/^<\s*\/\s*[｜|]?\s*DSML\s*[｜|]?\s*tool_calls\s*>/i);
        text = rest.slice(closeMatch?.[0].length || 0);
        inDslBlock = false;
        continue;
      }
      const open = text.search(/<\s*[｜|]?\s*DSML\s*[｜|]?\s*tool_calls\s*>/i);
      if (open < 0) {
        out += stripToolCallDSL(text);
        break;
      }
      out += stripToolCallDSL(text.slice(0, open));
      const rest = text.slice(open);
      const openMatch = rest.match(/^<\s*[｜|]?\s*DSML\s*[｜|]?\s*tool_calls\s*>/i);
      text = rest.slice(openMatch?.[0].length || 0);
      inDslBlock = true;
    }
    return out;
  };
  return {
    push(chunk) {
      pending += chunk;
      const keepFrom = Math.max(pending.lastIndexOf("<"), pending.lastIndexOf("＜"), pending.lastIndexOf("<｜DSML"), pending.lastIndexOf("<|DSML"));
      const keep = keepFrom >= 0 && pending.length - keepFrom < MAX_PENDING ? pending.slice(keepFrom) : "";
      const complete = keep ? pending.slice(0, -keep.length) : pending;
      pending = keep;
      return cleanComplete(complete);
    },
    flush() {
      const out = cleanComplete(pending);
      pending = "";
      return out;
    },
  };
}

assert.equal(
  stripToolCallDSL("前文<｜DSML｜tool_calls><｜DSML｜invoke name=\"get_quote\"><｜DSML｜parameter>USIXIC</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>后文"),
  "前文后文"
);
assert.equal(stripToolCallDSL("<invoke name=\"get_quote\">x</invoke>正文"), "x正文");
assert.equal(stripToolCallDSL("普通 <strong>HTML</strong> 保留"), "普通 <strong>HTML</strong> 保留");
assert.equal(stripToolCallDSL("＜｜DSML｜invoke name=\"x\">\n正文"), "\n正文");

const cleaner = createDSLStreamCleaner();
let out = "";
for (const chunk of ["回答开始", "<｜DS", "ML｜tool_calls><｜DSML｜invoke>", "secret", "</｜DSML｜invoke></｜DSML｜tool_calls>", "回答结束"]) {
  out += cleaner.push(chunk);
}
out += cleaner.flush();
assert.equal(out, "回答开始回答结束");

console.log("DSL cleaner tests passed");
