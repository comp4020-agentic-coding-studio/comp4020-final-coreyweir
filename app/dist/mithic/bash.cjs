'use strict';

const args = process.argv.slice(2);
const commandFlagIndex = args.findIndex(
  (arg) => /^-[^-]+$/.test(arg) && arg.slice(1).includes('c'),
);
let commandIndex = commandFlagIndex + 1;
while (
  commandIndex < args.length
  && (/^-[lexu]+$/.test(args[commandIndex])
    || ['--login', '--noprofile', '--norc'].includes(args[commandIndex]))
) {
  commandIndex++;
}

if (args.includes('--version')) {
  console.log('GNU bash, version 5.2.0(1)-release (nodepod-mithic)');
} else if (commandFlagIndex < 0 || commandIndex >= args.length) {
  console.error('mithic bash: only bash -c and bash -lc are supported');
  process.exitCode = 2;
} else {
  process.argv = [
    'node',
    '/opt/mithic/run-mithic.cjs',
    args[commandIndex],
    ...args.slice(commandIndex + 1),
  ];
  require('/opt/mithic/run-mithic.cjs');
}
