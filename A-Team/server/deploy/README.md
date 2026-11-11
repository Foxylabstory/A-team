# Автоматическая выкладка на Ubuntu 24.04

GitHub Actions проверяет каждый новый коммит в `master` на Ubuntu и отправляет на VPS проверенную версию сайта. Служба запускается от отдельного пользователя. Настройки, заявки и медиа хранятся вне каталога версий. При неудачном запуске скрипт возвращает предыдущую версию приложения. Изменения в базе при этом сохраняются.

## Однократная настройка VPS

Установите системный Node.js 24 LTS (минимум 24.13) и Nginx. Проверьте, что `node --version` работает из системного пути, например `/usr/local/bin/node`. Загрузите два файла из этой папки в домашний каталог на VPS и выполните там:

```sh
sudo useradd --system --user-group --no-create-home --shell /usr/sbin/nologin antipov
sudo useradd --system --user-group --create-home --shell /bin/bash antipov-deploy
sudo install -d -m 0755 /srv/antipov-team
sudo install -d -m 0755 -o antipov-deploy -g antipov-deploy /srv/antipov-team/releases
sudo install -d -m 0750 -o antipov -g antipov /var/lib/antipov-team
sudo install -m 0755 -o root -g root receive-deploy.sh /srv/antipov-team/receive-deploy.sh
sudo install -m 0644 antipov-team.service /etc/systemd/system/antipov-team.service
sudo systemctl daemon-reload
sudo systemctl enable antipov-team.service
```

В `/srv/antipov-team/site.env` задайте параметры ниже. Владелец файла — `root:antipov`, права — `0640`. Токены интеграций добавляются в этот файл на VPS.

```dotenv
NODE_ENV=production
SITE_URL=https://antipov.team
HOST=127.0.0.1
PORT=3000
TRUST_PROXY=loopback
DATA_DIR=/var/lib/antipov-team/data
BACKUP_DIR=/var/lib/antipov-team/backups
```

Создайте `/etc/sudoers.d/antipov-deploy` через `sudo visudo -f /etc/sudoers.d/antipov-deploy`. Пользователю выкладки достаточно двух команд для управления этой службой:

```sudoers
antipov-deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart antipov-team.service, /usr/bin/systemctl stop antipov-team.service
```

Создайте отдельную пару SSH-ключей Ed25519 для GitHub Actions. В `~antipov-deploy/.ssh/authorized_keys` поместите публичный ключ с ограничениями ниже, заменив пример на настоящий ключ. Каталог `.ssh` должен принадлежать `antipov-deploy` и иметь права `0700`, файл — `0600`. Для этого пользователя разрешите только вход по ключу.

```text
restrict,command="/srv/antipov-team/receive-deploy.sh" ssh-ed25519 AAAA… antipov-github-actions
```

## Настройка GitHub

В репозитории откройте Settings → Environments → production. Разрешите выкладку из `master`. Добавьте:

| Тип | Имя | Значение |
| --- | --- | --- |
| Variable | `VPS_HOST` | `95.182.123.176` |
| Secret | `VPS_SSH_KEY` | Приватная часть отдельного ключа GitHub Actions |
| Secret | `VPS_KNOWN_HOSTS` | Строка с адресом VPS и публичным ключом самого SSH-сервера |

Строку для `VPS_KNOWN_HOSTS` возьмите через доверенную консоль VPS или из уже проверенного SSH-сеанса:

```sh
awk '{print "95.182.123.176 " $1 " " $2}' /etc/ssh/ssh_host_ed25519_key.pub
```

После первого успешного запуска **Deploy Antipov Team** проверьте `curl -fsS http://127.0.0.1:3000/api/news` на VPS. Затем установите пароль администратора там же в интерактивном терминале:

```sh
cd /srv/antipov-team/releases/current
sudo -u antipov npm run admin:password
```

Проксируйте `antipov.team` на `127.0.0.1:3000` по [примеру Nginx в инструкции проекта](../README.md#публикация-на-сервере-в-рф). Направьте A-запись домена на VPS, выпустите HTTPS-сертификат и проверьте форму и `/admin/` через домен. Для ежедневных копий базы используйте `sudo -u antipov npm run db:backup` из текущей версии сайта и храните копии отдельно от VPS.
