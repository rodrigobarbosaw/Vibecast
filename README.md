# Playdahora

Player IPTV em português para listas do usuário. O cadastro inicia 14 dias corridos de acesso sem cartão. Depois, o servidor exige uma assinatura ativa para devolver os links salvos e o aplicativo bloqueia a reprodução.

O domínio previsto para produção é `https://playdahora.com.br`. Depois de apontar o domínio para a hospedagem, configure `APP_ORIGIN=https://playdahora.com.br` no servidor.

## Navegador

Use Node.js 24 ou superior.

```powershell
npm.cmd install
npm.cmd start
```

Abra http://localhost:3000. Cadastre um e-mail e uma senha do Playdahora e escolha entre link M3U ou servidor, usuário e senha IPTV (Xtream Codes). O nome da lista é opcional. Em contas existentes, troque a forma de conexão em **Minha lista**. A opção Xtream Codes consulta o catálogo e os episódios pela API `player_api.php` e usa `xmltv.php` quando não há um link de guia personalizado. Para links M3U, o app tenta usar o guia declarado no cabeçalho da lista se o campo estiver vazio.

A separação em **Ao vivo**, **Filmes**, **Séries** e **Músicas** usa os grupos, caminhos e extensões da lista. A programação usa o identificador `tvg-id` para localizar o canal no XMLTV. O servidor baixa a lista M3U e o EPG cadastrado de endereços públicos nas portas 80, 443, 8080, 8443 ou 25461. O player usa HLS nativo quando disponível, hls.js para URLs .m3u8 e reprodução direta para formatos aceitos pelo dispositivo. O EPG declarado apenas no cabeçalho M3U e os recursos carregados pelo hls.js precisam permitir CORS. Em produção, use streams HTTPS.

## Assinatura web

Para mostrar os 10 filmes em alta no início, defina `TMDB_READ_TOKEN` no `.env` com o token de leitura da API do TMDB. O ranking usa reproduções iniciadas no Playdahora e exibe os canais disponíveis na lista atual. As seções de adições recentes usam as datas fornecidas pelo provedor.

Copie `.env.example` para `.env`. Configure `STRIPE_SECRET_KEY` e `STRIPE_PRICE_ID` com a chave secreta e o ID de um preço recorrente. Escolha valor, moeda e intervalo no Stripe. Ajuste `APP_ORIGIN` para a origem pública HTTPS antes de hospedar. A aplicação consulta o status da assinatura no servidor, sem liberar acesso com base no redirecionamento do checkout.

Hospede o Node atrás de HTTPS. Em contêiner, defina `HOST=0.0.0.0` e monte um volume persistente em `DATA_DIR` para o SQLite. Restrinja o acesso ao volume e aos backups. Os links M3U e EPG podem conter credenciais do provedor.

## Android e iOS

A interface é compartilhada via Capacitor. Para o pacote móvel, configure a origem HTTPS do mesmo servidor. No PowerShell:

```powershell
$env:PLAYDAHORA_API_ORIGIN = 'https://playdahora.com.br'
npm.cmd run build
npx.cmd cap sync android
npx.cmd cap open android
```

No macOS com Xcode:

```sh
PLAYDAHORA_API_ORIGIN=https://playdahora.com.br npm run build
npx cap sync ios
npx cap open ios
```

As pastas Android e iOS já estão geradas. Execute `cap sync` após cada build web. O projeto usa Checkout no navegador. Para distribuição pelas lojas, a modalidade de cobrança precisa ser definida para cada loja e região, e a compra nativa ainda precisa ser implementada se exigida.

## Testes

```powershell
npm.cmd test
```
