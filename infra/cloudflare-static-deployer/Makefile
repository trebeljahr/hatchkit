.PHONY: check
check:
	python3 -I -c 'from pathlib import Path; [compile(p.read_text(), str(p), "exec") for p in (Path("deployer.py"), Path("test_deployer.py"))]'
	python3 -I -B test_deployer.py
