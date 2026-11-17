# Onboarding de um cliente

## Dia 0: contrato assinado

- [ ] Contrato e acordo de tratamento de dados assinados
- [ ] **Administração → Novo cliente**: criar o resort com o e-mail do responsável
- [ ] Enviar a palavra-passe temporária por um canal seguro (não no mesmo e-mail do link)
- [ ] Definir na ficha do cliente os limites do plano (minutos e chamadas em simultâneo)

## Dia 1: número

- [ ] Comprar o número no Twilio (português, com Regulatory Bundle aprovado)
- [ ] Twilio → número → Voice → *A call comes in*: Webhook, `POST`, `https://<url>/voice`
- [ ] Indicar o número na ficha do cliente

## Dias 1–3: configuração (com o cliente, cerca de 45 minutos)

- [ ] **Resort → Geral**: nome, morada, telefone da receção, regras de reserva
- [ ] **Resort → Quartos**: todos os tipos, com preços “desde” e ocupação máxima
- [ ] **Resort → Informação**: check-in e check-out, cancelamento, animais, estacionamento, refeições, as 10 perguntas mais frequentes
- [ ] **Resort → Idiomas**: idiomas ativos e saudações (manter a menção a inteligência artificial)
- [ ] Opcional, em **Integrações**: webhook para o CRM e/ou a API do PMS

## Dias 3–5: testes

- [ ] 10 chamadas de teste: disponibilidade, pedido de reserva, mudança de idioma, transferência, tecla 0, pergunta fora do âmbito
- [ ] Confirmar que os pedidos aparecem no painel (e no webhook, se configurado)
- [ ] Corrigir o perfil onde o assistente hesitou

## Entrada em produção

- [ ] Reencaminhar o número do resort (fora de horas, sem resposta ou sempre)
- [ ] Na primeira semana, rever com o cliente as chamadas transferidas e os pedidos
