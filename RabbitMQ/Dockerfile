FROM rabbitmq:3.11-management-alpine

RUN apk --no-cache add curl

RUN curl -L https://github.com/rabbitmq/rabbitmq-delayed-message-exchange/releases/download/3.11.1/rabbitmq_delayed_message_exchange-3.11.1.ez > rabbitmq_delayed_message_exchange-3.11.1.ez && \
mv rabbitmq_delayed_message_exchange-3.11.1.ez plugins/

RUN rabbitmq-plugins enable rabbitmq_delayed_message_exchange