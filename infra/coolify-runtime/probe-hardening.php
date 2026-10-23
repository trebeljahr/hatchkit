<?php
require '/var/www/html/vendor/autoload.php';
if (!function_exists('convertDockerRunToCompose')) { require '/var/www/html/bootstrap/helpers/docker.php'; }
function must($condition, $message) { if (!$condition) { throw new RuntimeException($message); } }
$input = '--cap-drop=ALL --security-opt=no-new-privileges:true --read-only --tmpfs=/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777 --pids-limit=256 --hostname=my-service --init';
$r = convertDockerRunToCompose($input);
must(($r['cap_drop'] ?? null) === ['ALL'], 'cap-drop lost');
must(($r['security_opt'] ?? null) === ['no-new-privileges:true'], 'hyphenated security value lost');
must(($r['read_only'] ?? null) === true, 'read-only lost');
must(($r['tmpfs'] ?? null) === ['/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777'], 'tmpfs lost');
must(($r['pids_limit'] ?? null) === 256, 'PID limit lost');
must(($r['hostname'] ?? null) === 'my-service', 'hostname regression');
must(($r['init'] ?? null) === true, 'init regression');
must(convertDockerRunToCompose('--read-only=false')['read_only'] === false, 'boolean false lost');
must(convertDockerRunToCompose('--tmpfs=/tmp:size=64m --tmpfs=/run:size=16m')['tmpfs'] === ['/tmp:size=64m','/run:size=16m'], 'repeat tmpfs lost');
foreach (['--pids-limit=0','--pids-limit=-1','--pids-limit=foo','--read-only=wrong'] as $bad) {
    $failed = false;
    try { convertDockerRunToCompose($bad); } catch (InvalidArgumentException $error) { $failed = true; }
    must($failed, 'invalid constraint accepted');
}
echo json_encode(['ok'=>true,'readOnly'=>true,'noNewPrivileges'=>true,'pids'=>256,'tmpfs'=>true,'regressions'=>true]),PHP_EOL;
