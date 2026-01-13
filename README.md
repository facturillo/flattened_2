# Product Management Service

Consolidated product management service running on Google Cloud Compute Engine (VM) with Managed Instance Group (MIG) for auto-healing and zero-downtime deployments.

## Infrastructure Components

| Component              | Name                                        | Details                                |
| ---------------------- | ------------------------------------------- | -------------------------------------- |
| VM Instance            | product-management-mig-\*                   | e2-small, Container-Optimized OS       |
| Managed Instance Group | product-management-mig                      | Regional (us-central1), target size: 1 |
| Instance Template      | product-management-template                 | Startup script based                   |
| Internal Load Balancer | product-management-forwarding-rule          | Static IP: 10.128.0.6:8080             |
| Health Check           | product-management-health-check             | HTTP /health on port 8080              |
| Backend Service        | product-management-backend                  | TCP, connected to MIG                  |
| Container Image        | gcr.io/panabudget/product-management:latest | Node.js 22 Alpine                      |

## Startup Script

The VM instances use the following startup script (stored in instance template metadata):

```bash
#!/bin/bash
CONTAINER_NAME="product-management"
IMAGE="gcr.io/panabudget/product-management:latest"

# Open firewall for health checks
iptables -A INPUT -p tcp --dport 8080 -j ACCEPT

# Configure docker credentials for GCR (COS-specific)
export HOME=/home/chronos
docker-credential-gcr configure-docker --registries=gcr.io

# Stop and remove existing container if any
docker stop $CONTAINER_NAME 2>/dev/null || true
docker rm $CONTAINER_NAME 2>/dev/null || true

# Pull latest image
docker pull $IMAGE

# Run container with Cloud Logging driver
docker run -d \
  --name=$CONTAINER_NAME \
  --restart=always \
  --network=host \
  --log-driver=gcplogs \
  --log-opt gcp-project=panabudget \
  --log-opt labels=container_name \
  --label container_name=$CONTAINER_NAME \
  $IMAGE
```

**Note:** Container-Optimized OS requires `docker-credential-gcr` (not `gcloud auth configure-docker`) and `HOME=/home/chronos` for GCR authentication.

## Firewall Rules

| Rule                                  | Source                        | Target Tags        | Port |
| ------------------------------------- | ----------------------------- | ------------------ | ---- |
| product-management-allow-health-check | 130.211.0.0/22, 35.191.0.0/16 | allow-health-check | 8080 |
| product-management-allow-internal     | Internal VPC                  | allow-internal     | 8080 |

## Pub/Sub Configuration

| Topic                    | Subscription                 | Purpose                     |
| ------------------------ | ---------------------------- | --------------------------- |
| product-processor        | product-processor-sub        | Process individual products |
| global-product-processor | global-product-processor-sub | Process global products     |
| vendor-prices-processor  | vendor-prices-processor-sub  | Process vendor prices       |

Subscription settings: pull mode, ack-deadline=120s, message-retention=1d, flow control maxMessages=10.

## Endpoints

| Endpoint                  | Method | Purpose                                | Called By                       |
| ------------------------- | ------ | -------------------------------------- | ------------------------------- |
| /health                   | GET    | Health check                           | MIG health checks               |
| /product-enhancer         | POST   | Enhance product data (sync)            | receipt-scanner via internal LB |
| /product-processor        | POST   | Process product (HTTP fallback)        | Direct calls                    |
| /global-product-processor | POST   | Process global product (HTTP fallback) | Direct calls                    |
| /vendor-prices-processor  | POST   | Process vendor prices (HTTP fallback)  | Direct calls                    |

## Request Flows

### Synchronous (product-enhancer)

receipt-scanner (Cloud Run with VPC Direct Egress) --> Internal LB (10.128.0.6:8080) --> VM /product-enhancer --> Response returned immediately

### Asynchronous (processors via Pub/Sub)

Cloud Function --> Pub/Sub Topic --> Subscription --> VM Pub/Sub Worker (pull) --> Processes message

## File Structure

product-management/
server.js - Express server + Pub/Sub workers
package.json
Dockerfile
cloudbuild.yaml - CI/CD for Cloud Build
shared/
firebase.js - Firebase Admin SDK init
vertexAI.js - Vertex AI / Gemini client
barcodeValidator.js - Barcode validation utilities
dataValidator.js - Data validation helpers
errorHandler.js - Error handling wrapper
httpClient.js - Axios wrapper with retries
pubsubWorker.js - Pub/Sub pull subscription worker
services/
productEnhancer.js - Main product enhancement logic
productProcessor.js - Product processing service
globalProductProcessor.js - Global product processing
vendorPricesProcessor.js - Vendor prices processing
systemInstructions/
brand.js - AI instructions for brand detection
category.js - AI instructions for categorization
productInstructions.js - AI instructions for product parsing
productDataExtractors/
extractors.js - Extractor registry
methods.js - Shared extraction methods
algolia/ - Algolia-based extractors (doItCenter, felipeMotta, novey, panafoto)
graphQl/ - GraphQL-based extractors (conway, rey, stevens, super99, superCarnes)
searchserverapi/ - SearchServerAPI extractors (felix, titan)
webPixels/ - WebPixels extractors (americanPets, melo, superBaru)
other/ - Other custom extractors (arrocha, blackDog, machetazo, ribaSmith, superXtra)

## Deployment (CI/CD)

Triggered automatically on push to main branch via Cloud Build trigger: product-management-deploy

### Cloud Build Steps

1. Pre-cleanup: Resize MIG to 1 (cleanup from any failed deploys)
2. Build: Docker build and tag with commit SHA + latest
3. Push: Push images to GCR
4. Rolling replace: Create new instance, wait for healthy, delete old
5. Wait stable: Confirm MIG is stable
6. Post-cleanup: Ensure MIG size is exactly 1

### Zero-Downtime Deploy Process

- max-surge=3 (required for regional MIG)
- max-unavailable=0 (always keep at least 1 healthy instance)
- New instance created, pulls :latest image via startup script
- Health check verifies new instance is healthy
- Old instance deleted only after new one is healthy
- Result: Always 1 instance running, no dropped requests

## Startup Script

The VM uses a startup script (not the deprecated gce-container-declaration method):

1. Opens iptables port 8080 for health checks
2. Configures docker credentials for GCR access
3. Stops and removes any existing container
4. Pulls latest container image from GCR
5. Runs container with:
   - --restart=always (auto-restart on failure)
   - --network=host (use host networking)
   - --log-driver=gcplogs (send logs to Cloud Logging)

## Logging

### Cloud Console Query

logName="projects/panabudget/logs/gcplogs-docker-driver"

### Filter by container name

logName="projects/panabudget/logs/gcplogs-docker-driver"
jsonPayload.container.name="product-management"

### View logs via SSH

gcloud compute ssh INSTANCE_NAME --zone=us-central1-b --command="sudo docker logs product-management"

### Follow logs in real-time

gcloud compute ssh INSTANCE_NAME --zone=us-central1-b --command="sudo docker logs -f product-management"

## Useful Commands

### Check MIG status

gcloud compute instance-groups managed list-instances product-management-mig --region=us-central1

### Check backend health

gcloud compute backend-services get-health product-management-backend --region=us-central1

### List running instances

gcloud compute instances list --filter="name~product-management"

### SSH into instance

gcloud compute ssh INSTANCE_NAME --zone=us-central1-b

### View container status

gcloud compute ssh INSTANCE_NAME --zone=us-central1-b --command="sudo docker ps"

### Test health endpoint locally

gcloud compute ssh INSTANCE_NAME --zone=us-central1-b --command="curl localhost:8080/health"

### Test via internal LB (from any VPC resource)

curl http://10.128.0.6:8080/health

### Manual resize MIG

gcloud compute instance-groups managed resize product-management-mig --region=us-central1 --size=1

### Force rolling restart

gcloud compute instance-groups managed rolling-action replace product-management-mig --region=us-central1 --max-surge=3 --max-unavailable=0

## Callers Configuration

### receipt-scanner (Cloud Run)

Must have VPC Direct Egress enabled to reach internal LB:

- Network: default
- Subnet: default
- Traffic routing: Route only requests to private IPs to the VPC

Calls: http://10.128.0.6:8080/product-enhancer

### Cloud Functions

Publish messages to Pub/Sub topics instead of HTTP calls:

- product-processor topic
- global-product-processor topic
- vendor-prices-processor topic

Example publish code:
const { PubSub } = require("@google-cloud/pubsub");
const pubsub = new PubSub();
await pubsub.topic("product-processor").publishMessage({
data: Buffer.from(JSON.stringify(payload)),
});

## Cost Optimization

- Single e2-small instance (~$15/month) vs multiple Cloud Run services
- Internal load balancer (no external traffic charges)
- Pub/Sub pull (no push endpoint needed)
- Auto-healing via MIG (no manual intervention)

## Troubleshooting

### Container not starting

gcloud compute ssh INSTANCE_NAME --zone=us-central1-b --command="sudo docker ps -a"
gcloud compute ssh INSTANCE_NAME --zone=us-central1-b --command="sudo journalctl -u google-startup-scripts --no-pager"

### Health check failing

gcloud compute ssh INSTANCE_NAME --zone=us-central1-b --command="curl -v localhost:8080/health"
gcloud compute ssh INSTANCE_NAME --zone=us-central1-b --command="sudo iptables -L INPUT -n | grep 8080"

### Pub/Sub not receiving messages

gcloud pubsub subscriptions describe product-processor-sub
gcloud compute ssh INSTANCE_NAME --zone=us-central1-b --command="sudo docker logs product-management | grep Worker"

### Check instance tags

gcloud compute instances describe INSTANCE_NAME --zone=us-central1-b --format="yaml(tags)"
