# Preços e custos (uso interno)

> Os custos abaixo são **estimativas**. Confirme os preços atuais da Twilio e da Anthropic e meça o custo real nas primeiras semanas: cada chamada fica registada com duração e número de trocas.

## Planos sugeridos

| | Essencial | Profissional | Grupo |
|---|---|---|---|
| Para | Hotel ou resort até ~60 quartos | Resort até ~200 quartos | Grupos e várias unidades |
| Mensalidade | 149 € | 349 € | Sob consulta |
| Minutos incluídos | 400 | 1 200 | Personalizado |
| Minuto extra | 0,25 € | 0,20 € | Personalizado |
| Chamadas em simultâneo | 3 | 8 | Personalizado |
| Idiomas | 5 | 5 | 5 |
| Webhook e ligação ao PMS | Sim | Sim | Sim |
| Configuração inicial | 390 € (uma vez) | 390 € (uma vez) | Incluída |

Preços sem IVA. Contrato anual com pagamento mensal, ou 2 meses grátis com pagamento anual.

Os limites são aplicados na ficha do cliente em **Administração**: minutos por mês e chamadas em simultâneo. Ao atingir o limite de minutos, as chamadas passam diretamente para a receção, por isso o hóspede nunca fica sem resposta.

## Custo estimado por minuto de chamada

| Componente | Estimativa | Notas |
|---|---|---|
| Twilio: número + chamada recebida + ConversationRelay (voz e transcrição) | 0,08–0,11 € | Varia com o país e o tipo de número |
| Claude (`claude-opus-5-5`, esforço baixo, prompt em cache) | 0,03–0,06 € | Cerca de 3 trocas por minuto |
| Alojamento (Render: web + Postgres) | ~0,01 € | ~25 €/mês repartidos pelos clientes |
| **Total** | **≈ 0,12–0,18 €/min** | |

## Margem estimada por plano (uso completo dos minutos)

| | Receita | Custo (0,15 €/min) | Margem bruta |
|---|---|---|---|
| Essencial | 149 € | 60 € | ~60% |
| Profissional | 349 € | 180 € | ~48% |

Na prática, a maioria dos clientes não usa todos os minutos, por isso a margem real tende a ser maior. Se precisar de reduzir custo, teste `CLAUDE_MODEL=claude-sonnet-5-5` com chamadas reais antes de mudar.

## Argumento de valor para o resort

- Um rececionista noturno custa mais de 1 500 €/mês. O Atendia não substitui a receção: cobre as noites, os picos e a época alta.
- Uma única reserva de 3 noites recuperada de uma chamada perdida costuma pagar o mês.
- Peça ao resort o número de chamadas perdidas por mês (o operador de telefone tem este dado). É o melhor argumento.
