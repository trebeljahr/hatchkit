SHELL := /bin/bash
INVENTORY ?= ansible/inventories/production/hosts.ini
STACK ?= node-realtime
TF_DIR := terraform/stacks/$(STACK)

.PHONY: help bootstrap harden lockdown verify tf-init tf-plan tf-apply tf-destroy coolify-setup

help:
	@echo "Targets:"
	@echo ""
	@echo "  Server hardening:"
	@echo "    harden      Run full security hardening       INVENTORY=<path>"
	@echo "    lockdown    Close Coolify bootstrap ports     INVENTORY=<path>"
	@echo "    bootstrap   Legacy baseline (use 'harden')    INVENTORY=<path>"
	@echo "    verify      Post-install checks               HOST=<domain> SSH_TARGET=<user@host>"
	@echo ""
	@echo "  Terraform (infra + DNS):"
	@echo "    tf-init     Initialize Terraform providers    STACK=<name>"
	@echo "    tf-plan     Preview changes                   STACK=<name>"
	@echo "    tf-apply    Apply changes                     STACK=<name>"
	@echo "    tf-destroy  Tear down infrastructure          STACK=<name>"
	@echo ""
	@echo "  Coolify (app stack):"
	@echo "    coolify-setup  Create app + DB in Coolify     STACK=<name>"
	@echo ""
	@echo "  Stacks: hardened-vps, node-realtime"

# Full security hardening (Tier 1 + Tier 2 from docs/hardening-guide.md)
harden:
	ansible-playbook -i $(INVENTORY) ansible/playbooks/harden.yml

# Post-Coolify lockdown: remove bootstrap ports (8000, 6001, 6002)
lockdown:
	ansible-playbook -i $(INVENTORY) ansible/playbooks/lockdown-coolify.yml

# Legacy bootstrap (kept for backwards compatibility)
bootstrap:
	ansible-playbook -i $(INVENTORY) ansible/playbooks/bootstrap.yml

verify:
	./scripts/verify-coolify.sh $(HOST) $(SSH_TARGET)

tf-init:
	cd $(TF_DIR) && terraform init

tf-plan:
	cd $(TF_DIR) && terraform plan

tf-apply:
	cd $(TF_DIR) && terraform apply

tf-destroy:
	@echo "This will DESTROY all infrastructure for stack '$(STACK)'."
	@echo "Press Ctrl+C to cancel, or Enter to continue."
	@read _
	cd $(TF_DIR) && terraform destroy

coolify-setup:
	./scripts/setup-coolify-stack.sh --config stacks/$(STACK).env
