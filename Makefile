.PHONY: install lint-server test-server build-server prettier-all launch launch-detached terminate logs migrate demo-env demo-env-down demo-pr-push demo-llm-outage demo-llm-restore demo-clear-git-cache

install:
	npm ci
	cd server && npm ci
	cd client && npm ci

lint-server:
	cd server && npm run lint

test-server:
	cd server && npm test

build-server:
	cd server && npm run build

prettier-all:
	npx prettier --write .
	cd server && npx prettier --write .
	cd client && npx prettier --write .

launch:
	docker compose up

launch-detached:
	docker compose up -d

terminate:
	docker compose down

logs:
	docker compose logs -f

migrate:
	docker compose run --rm migrate

# Local demo environment for factory demo videos (see factory/DEMO.md).
demo-env:
	./scripts/demo-env.sh

demo-env-down:
	docker compose -p marge-demo -f docker-compose.demo.yml down -v --remove-orphans

# PR reviewer demo steps (factory/DEMO.md): push new commits to PR #42, make
# the LLM fail and recover, and clear the git cache.
DEMO_SERVER = docker compose -p marge-demo -f docker-compose.demo.yml exec -T server

demo-pr-push:
	$(DEMO_SERVER) git -C /tmp/marge-pr-reviewer-github/playola-demo/station-scheduler \
	  update-ref refs/heads/feature/weekly-top-songs refs/pushed-later/feature/weekly-top-songs

demo-llm-outage:
	$(DEMO_SERVER) touch /tmp/marge-demo-llm-outage

demo-llm-restore:
	$(DEMO_SERVER) rm -f /tmp/marge-demo-llm-outage

demo-clear-git-cache:
	$(DEMO_SERVER) rm -rf /tmp/marge-pr-reviewer
