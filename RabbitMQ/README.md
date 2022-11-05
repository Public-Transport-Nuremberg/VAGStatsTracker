## Installation
Commands:  
```sh
mkdir ./rabbitmq && cd ./rabbitmq && mkdir ./log && kmdir ./data && cd ..
chmod -R 777 ./rabbitmq/log/
docker build -t rabbitmq-custom .
docker-compose up -d
```

## Updating/Operating
```sh
docker build -t rabbitmq-custom .
docker-compose up -d
```