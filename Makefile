.PHONY: install lint-server test-server build-server prettier-all launch launch-detached terminate logs migrate demo-env demo-env-down

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
