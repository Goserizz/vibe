/**
 * Quick self-check for mathPreprocess (run: npx tsx web/src/lib/mathPreprocess.selftest.ts)
 */
import { preprocessMath } from './mathPreprocess';

function check(name: string, input: string, expected: string): void {
  const got = preprocessMath(input);
  const ok = got === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) {
    console.log('  input   :', JSON.stringify(input));
    console.log('  expected:', JSON.stringify(expected));
    console.log('  got     :', JSON.stringify(got));
  }
}

check('bare formula', String.raw`\alpha = a/\text{scale}`, String.raw`$\alpha = a/\text{scale}$`);
check('paren inline', String.raw`hi \alpha = 1 there`, String.raw`hi $\alpha = 1$ there`);
check('\\( \\)', String.raw`see \(E=mc^2\) please`, String.raw`see $E=mc^2$ please`);
check('\\[ \\]', 'block:\n\\[a+b\\]\nok', 'block:\n$$a+b$$\nok');
check('code fence untouched', '```\n\\alpha = 1\n```', '```\n\\alpha = 1\n```');
check('inline code untouched', 'use `\\alpha` here', 'use `\\alpha` here');
check('existing $ untouched', 'already $\\alpha$ wrapped', 'already $\\alpha$ wrapped');
check('existing $$ untouched', 'disp $$\\sum x$$ end', 'disp $$\\sum x$$ end');
check('\\nfoo left alone', String.raw`\nfoo`, String.raw`\nfoo`);
check('Windows-ish path left alone', String.raw`path \Users\foo`, String.raw`path \Users\foo`);
check('no backslash noop', 'plain text', 'plain text');
check('frac with braces', String.raw`\frac{1}{2} = 0.5`, String.raw`$\frac{1}{2} = 0.5$`);

console.log('done');
