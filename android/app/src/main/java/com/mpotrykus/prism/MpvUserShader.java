package com.mpotrykus.prism;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/* Java port of src/player/shader/mpv-user-shader.js - loader for mpv's user-shader format
   (//!HOOK/!BIND/!SAVE/...), the exact vendored upstream files under
   assets/shaders/vendor/*.glsl (Anime4K CNN, FSR 1). See that JS file's own header comment for
   why these are consumed verbatim rather than hand-ported: the weights are trained parameters,
   not something a transcription can safely approximate, and a version bump stays a re-download.

   Kept as close to a line-for-line port of the JS as Java allows, including the same supported
   directive subset (HOOK, BIND, SAVE, WIDTH, HEIGHT, COMPONENTS, DESC, WHEN) and the same
   rejected ones (COMPUTE, TEXTURE, FORMAT, FILTER, SIZE) - see the JS file for why. */
final class MpvUserShader {

    private MpvUserShader() {}

    // ---- RPN size/gate expression evaluator ----

    interface RpnLookup {
        /** Returns {w, h} for a symbol name, or {OUTPUT.w, OUTPUT.h} etc. */
        double[] lookup(String symbol);
    }

    private static double binaryOp(String op, double a, double b) {
        switch (op) {
            case "+": return a + b;
            case "-": return a - b;
            case "*": return a * b;
            case "/": return a / b;
            case ">": return a > b ? 1 : 0;
            case "<": return a < b ? 1 : 0;
            case "=": return a == b ? 1 : 0;
            default: throw new IllegalArgumentException("unknown RPN op " + op);
        }
    }

    private static final Pattern SWIZZLE = Pattern.compile("^(.+)\\.(w|h)$");

    static double evalRpn(String expr, RpnLookup lookup) {
        Deque<Double> stack = new ArrayDeque<>();
        for (String token : expr.trim().split("\\s+")) {
            if (token.isEmpty()) continue;
            if (token.equals("!")) {
                double a = stack.pop();
                stack.push(a != 0 ? 0.0 : 1.0);
                continue;
            }
            if ("+-*/><=".contains(token) && token.length() == 1) {
                if (stack.size() < 2) throw new IllegalStateException("RPN underflow in \"" + expr + "\"");
                double b = stack.pop();
                double a = stack.pop();
                stack.push(binaryOp(token, a, b));
                continue;
            }
            try {
                stack.push(Double.parseDouble(token));
                continue;
            } catch (NumberFormatException ignored) {
                // fall through to symbol handling
            }
            Matcher m = SWIZZLE.matcher(token);
            if (!m.matches()) throw new IllegalArgumentException("unsupported RPN token \"" + token + "\" in \"" + expr + "\"");
            double[] wh = lookup.lookup(m.group(1));
            stack.push(m.group(2).equals("w") ? wh[0] : wh[1]);
        }
        if (stack.size() != 1) throw new IllegalStateException("RPN \"" + expr + "\" left " + stack.size() + " values on the stack");
        return stack.pop();
    }

    // ---- directive parsing ----

    private static final Pattern DIRECTIVE = Pattern.compile("^//!\\s*([A-Z_]+)\\s*(.*)$");

    private static final class Directive {
        final String key;
        final String value;
        Directive(String key, String value) { this.key = key; this.value = value; }
    }

    private static final class RawPass {
        final List<Directive> directives = new ArrayList<>();
        final List<String> body = new ArrayList<>();
    }

    private static List<RawPass> splitPasses(String source) {
        List<RawPass> passes = new ArrayList<>();
        RawPass current = null;
        boolean inDirectiveBlock = false;
        for (String line : source.split("\r?\n", -1)) {
            Matcher m = DIRECTIVE.matcher(line);
            if (m.matches()) {
                if (!inDirectiveBlock) {
                    current = new RawPass();
                    passes.add(current);
                    inDirectiveBlock = true;
                }
                current.directives.add(new Directive(m.group(1), m.group(2).trim()));
                continue;
            }
            inDirectiveBlock = false;
            if (current != null) current.body.add(line);
        }
        return passes;
    }

    private static String directiveValue(List<Directive> directives, String key) {
        for (Directive d : directives) if (d.key.equals(key)) return d.value;
        return null;
    }

    // ---- GLSL ES 3.00 wrapping (mpv per-binding macros) ----

    private static String bindingMacros(String name) {
        return "uniform sampler2D " + name + ";\n"
            + "uniform vec2 " + name + "Size;\n"
            + "#define " + name + "_tex(p) texture(" + name + ", p)\n"
            + "#define " + name + "_texOff(o) texture(" + name + ", vUv + (o) * (1.0 / " + name + "Size))\n"
            + "#define " + name + "_pos vUv\n"
            + "#define " + name + "_size " + name + "Size\n"
            + "#define " + name + "_pt (1.0 / " + name + "Size)\n"
            + "#define " + name + "_mul 1.0\n"
            + "#define " + name + "_raw " + name + "_tex\n";
    }

    private static final String PREAMBLE = "#version 300 es\n"
        + "precision highp float;\n"
        + "precision highp sampler2D;\n"
        + "in vec2 vUv;\n"
        + "out vec4 prismFragColor;\n";

    private static final String EPILOGUE = "\nvoid main() { prismFragColor = hook(); }\n";

    // ---- pass graph result ----

    interface WhenGate {
        boolean test(int sourceW, int sourceH, int outW, int outH);
    }

    static final class LoadResult {
        final List<GlPassChain.PassSpec> passes;
        final WhenGate when;
        LoadResult(List<GlPassChain.PassSpec> passes, WhenGate when) {
            this.passes = passes;
            this.when = when;
        }
    }

    static LoadResult load(String source, String name, String inputSymbol) {
        List<RawPass> raw = splitPasses(source);
        if (raw.isEmpty()) throw new IllegalArgumentException(name + ": no //! directives found");

        Map<String, String> symbols = new HashMap<>();
        symbols.put("MAIN", inputSymbol);
        symbols.put("LUMA", inputSymbol);
        symbols.put("NATIVE", inputSymbol);
        symbols.put("HOOKED", inputSymbol);

        List<GlPassChain.PassSpec> passes = new ArrayList<>();
        String[] whenHolder = new String[1];

        for (int index = 0; index < raw.size(); index++) {
            RawPass entry = raw.get(index);
            String desc = directiveValue(entry.directives, "DESC");
            if (desc == null) desc = name + " pass " + index;

            for (Directive d : entry.directives) {
                if (d.key.equals("COMPUTE")) {
                    throw new IllegalArgumentException(desc + ": COMPUTE passes need compute shaders, unavailable here");
                }
                if (d.key.equals("TEXTURE") || d.key.equals("FORMAT") || d.key.equals("FILTER") || d.key.equals("SIZE")) {
                    throw new IllegalArgumentException(desc + ": loader-supplied " + d.key + " textures are not supported");
                }
            }

            String hook = directiveValue(entry.directives, "HOOK");
            if (hook == null) throw new IllegalArgumentException(desc + ": missing //!HOOK");
            if (!symbols.containsKey(hook)) throw new IllegalArgumentException(desc + ": unsupported hook target \"" + hook + "\"");

            String passWhen = directiveValue(entry.directives, "WHEN");
            if (passWhen != null) {
                if (whenHolder[0] == null) whenHolder[0] = passWhen;
                else if (!whenHolder[0].equals(passWhen)) {
                    throw new IllegalArgumentException(desc + ": two different //!WHEN clauses in one file");
                }
            }

            List<String> binds = new ArrayList<>();
            for (Directive d : entry.directives) if (d.key.equals("BIND")) binds.add(d.value);
            if (binds.isEmpty()) throw new IllegalArgumentException(desc + ": no //!BIND");
            String id = name + "#" + index;

            List<GlPassChain.PassSpec.Input> inputs = new ArrayList<>();
            for (String bind : binds) {
                String target = bind.equals("HOOKED") ? hook : bind;
                if (!symbols.containsKey(target)) throw new IllegalArgumentException(desc + ": BIND \"" + bind + "\" before anything SAVEd it");
                inputs.add(new GlPassChain.PassSpec.Input(bind, symbols.get(target)));
            }

            String widthExpr = directiveValue(entry.directives, "WIDTH");
            String heightExpr = directiveValue(entry.directives, "HEIGHT");
            // Snapshot, not the live `symbols` map - see mpv-user-shader.js's own comment on why
            // this must be captured now rather than resolved lazily at render time.
            Map<String, String> symbolsHere = new HashMap<>(symbols);

            StringBuilder frag = new StringBuilder(PREAMBLE);
            for (String bind : binds) frag.append(bindingMacros(bind));
            frag.append(String.join("\n", entry.body));
            frag.append(EPILOGUE);

            GlPassChain.PassSpec.SizeFn sizeFn = (ctx) -> {
                MpvUserShader.RpnLookup lookup = (symbol) -> {
                    if (symbol.equals("OUTPUT")) return new double[] {ctx.outW(), ctx.outH()};
                    String resolved = symbolsHere.containsKey(symbol) ? symbolsHere.get(symbol) : symbol;
                    int[] size = ctx.sizeOf(resolved);
                    return new double[] {size[0], size[1]};
                };
                int[] inSize = ctx.sizeOf(inputs.get(0).from);
                int w = widthExpr != null ? (int) Math.round(evalRpn(widthExpr, lookup)) : inSize[0];
                int h = heightExpr != null ? (int) Math.round(evalRpn(heightExpr, lookup)) : inSize[1];
                return new int[] {w, h};
            };

            passes.add(new GlPassChain.PassSpec(id, frag.toString(), inputs, sizeFn, 1f, /* floatRequired= */ true));

            String save = directiveValue(entry.directives, "SAVE");
            if (save == null) save = hook;
            symbols.put(save, id);
        }

        String when = whenHolder[0];
        WhenGate gate = when == null ? null : (sourceW, sourceH, outW, outH) -> evalRpn(when, (symbol) ->
            symbol.equals("OUTPUT") ? new double[] {outW, outH} : new double[] {sourceW, sourceH}) != 0;

        return new LoadResult(passes, gate);
    }

    static final class NamedSource {
        final String source;
        final String name;
        NamedSource(String source, String name) { this.source = source; this.name = name; }
    }

    /** Concatenates several user-shader files into one chain - mpv's glsl-shaders=a:b. */
    static LoadResult loadChain(List<NamedSource> sources, String inputSymbol) {
        List<GlPassChain.PassSpec> passes = new ArrayList<>();
        List<WhenGate> gates = new ArrayList<>();
        String sourceSymbol = inputSymbol;
        for (NamedSource ns : sources) {
            LoadResult loaded = load(ns.source, ns.name, sourceSymbol);
            passes.addAll(loaded.passes);
            if (loaded.when != null) gates.add(loaded.when);
            sourceSymbol = loaded.passes.get(loaded.passes.size() - 1).name;
        }
        WhenGate combined = gates.isEmpty() ? null : (sourceW, sourceH, outW, outH) -> {
            for (WhenGate g : gates) if (!g.test(sourceW, sourceH, outW, outH)) return false;
            return true;
        };
        return new LoadResult(passes, combined);
    }
}
