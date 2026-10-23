#!/usr/bin/env python3
"""Fail-closed compatibility patch for Coolify 4.4.7 run-option conversion.

Upstream currently truncates hyphenated values and omits read-only, tmpfs and
PID limits. Keep the upstream helper and extend only these conversion cases.
Every new upstream image must pass the same PHP behavioral probe before use.
"""
import pathlib,sys

def patch(text):
 start=text.index('function convertDockerRunToCompose(')
 end=text.index('\nfunction generateCustomDockerRunOptionsForDatabases(',start)
 body=text[start:end]
 edits=[
  (r'([^\s-]+)?/',r'((?!--)[^\s]+)?/'),
  ("        '--dns',\n", "        '--dns',\n        '--tmpfs',\n"),
  ("        '--dns' => 'dns',\n", "        '--dns' => 'dns',\n        '--tmpfs' => 'tmpfs',\n        '--read-only' => 'read_only',\n        '--pids-limit' => 'pids_limit',\n"),
  ("        if ($option === '--ulimit') {", """        if ($option === '--read-only') {
            $raw = is_array($value) ? ($value[0] ?? null) : $value;
            if ($raw === true || $raw === 'true') {
                $compose_options->put('read_only', true);
            } elseif ($raw === 'false') {
                $compose_options->put('read_only', false);
            } else {
                throw new InvalidArgumentException('read-only requires true or false');
            }
        } elseif ($option === '--pids-limit') {
            $raw = is_array($value) ? ($value[0] ?? null) : null;
            if (!is_string($raw) || !ctype_digit($raw) || (int)$raw < 1 || (int)$raw > 65535) {
                throw new InvalidArgumentException('pids-limit requires 1..65535');
            }
            $compose_options->put('pids_limit', (int)$raw);
        } elseif ($option === '--ulimit') {"""),
 ]
 for old,new in edits:
  if body.count(old)!=1:raise ValueError('Upstream helper changed: review compatibility patch before deploying')
  body=body.replace(old,new,1)
 return text[:start]+body+text[end:]

if __name__=='__main__':
 p=pathlib.Path(sys.argv[1]);p.write_text(patch(p.read_text()))
