// =============================================================================
// Stage 3 Declarative Jenkins Pipeline: Microservices CI/CD to AWS Kubernetes
// =============================================================================
// Key Architectural Highlights:
// 1. Immutable ECR Image Tagging (sha-${GIT_COMMIT[0..6]})
// 2. Parallel Multi-Service Docker Build & ECR Push
// 3. AWS IAM Instance Profile Authentication (Zero static access keys)
// 4. Dynamic Infrastructure Discovery via AWS SSM Parameter Store
// 5. AWS Secrets Manager to Kubernetes Secret Synchronization (Masked in logs)
// 6. Completely Private Cluster Deployment via AWS Systems Manager (SSM)
// 7. Automated Zero-Downtime Rollout Verification & Auto-Rollback on Failure
// =============================================================================

pipeline {
    agent any

    options {
        timestamps()
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '10'))
        timeout(time: 30, unit: 'MINUTES')
    }

    environment {
        AWS_DEFAULT_REGION   = 'ap-southeast-2'
        AWS_REGION           = 'ap-southeast-2'
        K8S_NAMESPACE        = 'prod'
        IMAGE_TAG            = "sha-${env.GIT_COMMIT ? env.GIT_COMMIT.take(7) : 'manual'}"
        PROJECT_TAG          = 'task-stats-microservices'
    }

    stages {
        // ---------------------------------------------------------------------
        // Stage 1: Discovery & Dynamic Parameter Resolution
        // ---------------------------------------------------------------------
        stage('Init & Fetch AWS Metadata') {
            steps {
                script {
                    echo "=========================================================="
                    echo " Stage 1: Resolving Infrastructure Metadata via AWS SSM   "
                    echo " Target Region : ${AWS_REGION}                            "
                    echo " Target Image  : ${IMAGE_TAG}                             "
                    echo "=========================================================="

                    // Resolve ECR Repository URLs from SSM Parameter Store (Stage 1 Output)
                    env.TASK_ECR_URL = sh(
                        script: "aws ssm get-parameter --name /prod/app/ecr_task_repo_url --query 'Parameter.Value' --output text --region ${AWS_REGION}",
                        returnStdout: true
                    ).trim()

                    env.STATS_ECR_URL = sh(
                        script: "aws ssm get-parameter --name /prod/app/ecr_stats_repo_url --query 'Parameter.Value' --output text --region ${AWS_REGION}",
                        returnStdout: true
                    ).trim()

                    // Resolve RDS PostgreSQL Endpoint from SSM
                    env.RDS_ENDPOINT = sh(
                        script: "aws ssm get-parameter --name /prod/app/rds_endpoint --query 'Parameter.Value' --output text --region ${AWS_REGION}",
                        returnStdout: true
                    ).trim()

                    // Resolve Public ALB DNS Name from SSM
                    env.ALB_DNS = sh(
                        script: "aws ssm get-parameter --name /prod/app/alb_dns --query 'Parameter.Value' --output text --region ${AWS_REGION}",
                        returnStdout: true
                    ).trim()

                    // Identify Kubernetes Master Node EC2 Instance ID for SSM Remote Execution
                    env.MASTER_INSTANCE_ID = sh(
                        script: """
                            aws ec2 describe-instances \
                                --filters "Name=tag:Project,Values=${PROJECT_TAG}" \
                                          "Name=tag:Role,Values=k8s-master" \
                                          "Name=instance-state-name,Values=running" \
                                --query "Reservations[0].Instances[0].InstanceId" \
                                --output text \
                                --region ${AWS_REGION}
                        """,
                        returnStdout: true
                    ).trim()

                    // Extract ECR Registry Host from Repository URL
                    env.ECR_REGISTRY = env.TASK_ECR_URL.tokenize('/')[0]

                    echo "Discovered Metadata:"
                    echo " - task-service ECR : ${env.TASK_ECR_URL}"
                    echo " - stats-service ECR: ${env.STATS_ECR_URL}"
                    echo " - ECR Registry Host: ${env.ECR_REGISTRY}"
                    echo " - RDS Endpoint     : ${env.RDS_ENDPOINT}"
                    echo " - ALB Public DNS   : ${env.ALB_DNS}"
                    echo " - Master EC2 ID    : ${env.MASTER_INSTANCE_ID}"

                    if (!env.MASTER_INSTANCE_ID || env.MASTER_INSTANCE_ID == 'None') {
                        error("Unable to discover running Kubernetes Master EC2 instance with tag Role=k8s-master in ${AWS_REGION}")
                    }
                }
            }
        }

        // ---------------------------------------------------------------------
        // Stage 2: Authenticate Docker to Amazon ECR
        // ---------------------------------------------------------------------
        stage('ECR Login') {
            steps {
                script {
                    echo "Authenticating Docker CLI to Amazon ECR via IAM Instance Profile..."
                    sh """
                        aws ecr get-login-password --region ${AWS_REGION} | \
                        docker login --username AWS --password-stdin ${env.ECR_REGISTRY}
                    """
                }
            }
        }

        // ---------------------------------------------------------------------
        // Stage 3: Parallel Docker Image Build & Push to Amazon ECR
        // ---------------------------------------------------------------------
        stage('Docker Build & Push to ECR') {
            failFast true
            parallel {
                stage('Build & Push task-service') {
                    steps {
                        script {
                            echo "Building and tagging task-service image: ${env.TASK_ECR_URL}:${IMAGE_TAG}"
                            sh """
                                docker build -t ${env.TASK_ECR_URL}:${IMAGE_TAG} ./task-service
                                docker push ${env.TASK_ECR_URL}:${IMAGE_TAG}
                            """
                        }
                    }
                }
                stage('Build & Push stats-service') {
                    steps {
                        script {
                            echo "Building and tagging stats-service image: ${env.STATS_ECR_URL}:${IMAGE_TAG}"
                            sh """
                                docker build -t ${env.STATS_ECR_URL}:${IMAGE_TAG} ./stats-service
                                docker push ${env.STATS_ECR_URL}:${IMAGE_TAG}
                            """
                        }
                    }
                }
            }
        }

        // ---------------------------------------------------------------------
        // Stage 3: Sync RDS Credentials from AWS Secrets Manager to K8s Secret
        // ---------------------------------------------------------------------
        stage('Sync RDS Secret to K8s') {
            steps {
                script {
                    echo "Retrieving RDS Master User Secret and updating Kubernetes Secret 'db-credentials'..."
                    // Wrapped in set +x to strictly prevent secrets or sensitive strings from leaking into Jenkins logs
                    sh """
                        set +x
                        echo "[INFO] Fetching RDS master user secret ARN..."
                        RDS_SECRET_ARN=\$(aws rds describe-db-instances \
                            --db-instance-identifier rds-prod-postgres \
                            --query "DBInstances[0].MasterUserSecret.SecretArn" \
                            --output text \
                            --region ${AWS_REGION})

                        if [ -z "\$RDS_SECRET_ARN" ] || [ "\$RDS_SECRET_ARN" = "None" ]; then
                            echo "[ERROR] Could not find MasterUserSecret for RDS instance rds-prod-postgres"
                            exit 1
                        fi

                        echo "[INFO] Retrieving SecretString from AWS Secrets Manager..."
                        SECRET_JSON=\$(aws secretsmanager get-secret-value \
                            --secret-id "\$RDS_SECRET_ARN" \
                            --query SecretString \
                            --output text \
                            --region ${AWS_REGION})

                        DB_USER=\$(echo "\$SECRET_JSON" | grep -o '"username": *"[^"]*"' | sed 's/"username": *"//;s/"//')
                        DB_PASS=\$(echo "\$SECRET_JSON" | grep -o '"password": *"[^"]*"' | sed 's/"password": *"//;s/"//')
                        DB_HOST=\$(echo "${env.RDS_ENDPOINT}" | cut -d: -f1)
                        DB_PORT=\$(echo "${env.RDS_ENDPOINT}" | cut -d: -f2)

                        DB_NAME=\$(aws rds describe-db-instances \
                            --db-instance-identifier rds-prod-postgres \
                            --query "DBInstances[0].DBName" \
                            --output text \
                            --region ${AWS_REGION})
                        if [ -z "\$DB_NAME" ] || [ "\$DB_NAME" = "None" ]; then
                            DB_NAME="taskdb"
                        fi

                        # Encode special characters in password for valid URL construction
                        ENCODED_PASS=\$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote_plus(sys.argv[1]))" "\$DB_PASS" 2>/dev/null || python -c "import urllib.parse, sys; print(urllib.parse.quote_plus(sys.argv[1]))" "\$DB_PASS")
                        DATABASE_URL="postgresql://\${DB_USER}:\${ENCODED_PASS}@\${DB_HOST}:\${DB_PORT}/\${DB_NAME}"

                        echo "[INFO] Preparing encoded Kubernetes secret creation payload..."
                        # Base64 encode the values for direct remote execution
                        B64_DB_URL=\$(echo -n "\$DATABASE_URL" | base64 | tr -d '\n')
                        B64_DB_USER=\$(echo -n "\$DB_USER" | base64 | tr -d '\n')
                        B64_DB_PASS=\$(echo -n "\$DB_PASS" | base64 | tr -d '\n')

                        # Build the full secret manifest in base64 to eliminate newline and quote escaping issues
                        B64_SECRET_MANIFEST=\$(cat <<EOF | base64 | tr -d '\n'
apiVersion: v1
kind: Secret
metadata:
  name: db-credentials
  namespace: ${K8S_NAMESPACE}
type: Opaque
data:
  DATABASE_URL: \${B64_DB_URL}
  POSTGRES_USER: \${B64_DB_USER}
  POSTGRES_PASSWORD: \${B64_DB_PASS}
EOF
)

                        cat <<EOF > /tmp/ssm-secret-params.json
{
  "commands": [
    "echo '\${B64_SECRET_MANIFEST}' | base64 -d | kubectl apply -f -"
  ]
}
EOF

                        echo "[INFO] Dispatching secret update to Master EC2 via AWS SSM..."
                        CMD_ID=\$(aws ssm send-command \
                            --instance-ids "${env.MASTER_INSTANCE_ID}" \
                            --document-name "AWS-RunShellScript" \
                            --comment "Sync RDS Credentials to K8s Secret" \
                            --parameters file:///tmp/ssm-secret-params.json \
                            --query "Command.CommandId" \
                            --output text \
                            --region ${AWS_REGION})
                        rm -f /tmp/ssm-secret-params.json

                        aws ssm wait command-executed \
                            --command-id "\$CMD_ID" \
                            --instance-id "${env.MASTER_INSTANCE_ID}" \
                            --region ${AWS_REGION}

                        STATUS=\$(aws ssm get-command-invocation \
                            --command-id "\$CMD_ID" \
                            --instance-id "${env.MASTER_INSTANCE_ID}" \
                            --query "Status" \
                            --output text \
                            --region ${AWS_REGION})

                        echo "Secret sync execution status: \$STATUS"
                        aws ssm get-command-invocation \
                            --command-id "\$CMD_ID" \
                            --instance-id "${env.MASTER_INSTANCE_ID}" \
                            --query "StandardOutputContent" \
                            --output text \
                            --region ${AWS_REGION} || true

                        if [ "\$STATUS" != "Success" ]; then
                            echo "[ERROR] SSM Command failed with status \$STATUS"
                            aws ssm get-command-invocation \
                                --command-id "\$CMD_ID" \
                                --instance-id "${env.MASTER_INSTANCE_ID}" \
                                --query "StandardErrorContent" \
                                --output text \
                                --region ${AWS_REGION} || true
                            exit 1
                        fi

                        echo "[SUCCESS] Secret 'db-credentials' successfully synced to namespace ${K8S_NAMESPACE}."
                    """
                }
            }
        }

        // ---------------------------------------------------------------------
        // Stage 4: Deploy Rendered Manifests & Verify Rollout via AWS SSM
        // ---------------------------------------------------------------------
        stage('Deploy Manifests & Verify Rollout') {
            steps {
                script {
                    echo "Rendering Kubernetes manifests with immutable image tag: ${IMAGE_TAG}..."
                    sh """
                        rm -rf /tmp/k8s-rendered && mkdir -p /tmp/k8s-rendered
                        cp k8s/*.yaml /tmp/k8s-rendered/

                        # Substitute image placeholders with exact ECR immutable URIs
                        sed -i 's|TASK_IMAGE_PLACEHOLDER|${env.TASK_ECR_URL}:${IMAGE_TAG}|g' /tmp/k8s-rendered/task-service.yaml
                        sed -i 's|STATS_IMAGE_PLACEHOLDER|${env.STATS_ECR_URL}:${IMAGE_TAG}|g' /tmp/k8s-rendered/stats-service.yaml

                        echo "Creating compressed base64 payload of rendered manifests..."
                        MANIFEST_PAYLOAD=\$(tar -czf - -C /tmp/k8s-rendered . | base64 | tr -d '\n')

                        echo "Dispatching deployment and rollout verification to Master EC2 via AWS SSM..."
                        cat << EOF > /tmp/ssm-deploy-params.json
{
  "commands": [
    "mkdir -p /tmp/k8s-deploy",
    "echo '\${MANIFEST_PAYLOAD}' | base64 -d | tar -xzf - -C /tmp/k8s-deploy",
    "kubectl apply -f /tmp/k8s-deploy/configmap.yaml",
    "kubectl apply -f /tmp/k8s-deploy/task-service.yaml",
    "kubectl apply -f /tmp/k8s-deploy/stats-service.yaml",
    "kubectl apply -f /tmp/k8s-deploy/ingress.yaml",
    "kubectl rollout status deployment/task-service -n ${K8S_NAMESPACE} --timeout=180s",
    "kubectl rollout status deployment/stats-service -n ${K8S_NAMESPACE} --timeout=180s",
    "rm -rf /tmp/k8s-deploy"
  ]
}
EOF

                        CMD_ID=\$(aws ssm send-command \
                            --instance-ids "${env.MASTER_INSTANCE_ID}" \
                            --document-name "AWS-RunShellScript" \
                            --comment "Stage 3 Kubernetes Application Deployment" \
                            --parameters file:///tmp/ssm-deploy-params.json \
                            --query "Command.CommandId" \
                            --output text \
                            --region ${AWS_REGION})
                        rm -f /tmp/ssm-deploy-params.json

                        echo "Waiting for SSM deployment command execution (Command ID: \$CMD_ID)..."
                        aws ssm wait command-executed \
                            --command-id "\$CMD_ID" \
                            --instance-id "${env.MASTER_INSTANCE_ID}" \
                            --region ${AWS_REGION}

                        STATUS=\$(aws ssm get-command-invocation \
                            --command-id "\$CMD_ID" \
                            --instance-id "${env.MASTER_INSTANCE_ID}" \
                            --query "Status" \
                            --output text \
                            --region ${AWS_REGION})

                        echo "Deployment execution status: \$STATUS"
                        aws ssm get-command-invocation \
                            --command-id "\$CMD_ID" \
                            --instance-id "${env.MASTER_INSTANCE_ID}" \
                            --query "StandardOutputContent" \
                            --output text \
                            --region ${AWS_REGION}

                        if [ "\$STATUS" != "Success" ]; then
                            echo "[ERROR] Deployment failed on Master node:"
                            aws ssm get-command-invocation \
                                --command-id "\$CMD_ID" \
                                --instance-id "${env.MASTER_INSTANCE_ID}" \
                                --query "StandardErrorContent" \
                                --output text \
                                --region ${AWS_REGION}
                            exit 1
                        fi

                        rm -rf /tmp/k8s-rendered
                    """
                }
            }
        }

        // ---------------------------------------------------------------------
        // Stage 5: Production Smoke Tests
        // ---------------------------------------------------------------------
        stage('Smoke Test') {
            steps {
                script {
                    echo "Running smoke tests against Public ALB DNS: ${env.ALB_DNS}..."
                    sh """
                        echo "[1/3] Verifying ALB Target Group health check endpoint (/healthz)..."
                        ALB_HEALTH=\$(curl -s -o /dev/null -w "%{http_code}" --retry 5 --retry-delay 5 --max-time 10 "http://${env.ALB_DNS}/healthz")
                        echo "ALB /healthz HTTP Response Code: \$ALB_HEALTH"
                        if [ "\$ALB_HEALTH" != "200" ]; then
                            echo "[ERROR] ALB health check endpoint did not return 200 OK"
                            exit 1
                        fi

                        echo "[2/3] Testing task-service API endpoint (/api/tasks)..."
                        TASKS_STATUS=\$(curl -s -o /dev/null -w "%{http_code}" --retry 5 --retry-delay 5 --max-time 10 "http://${env.ALB_DNS}/api/tasks")
                        echo "GET /api/tasks HTTP Response Code: \$TASKS_STATUS"
                        if [ "\$TASKS_STATUS" != "200" ]; then
                            echo "[ERROR] task-service API did not return 200 OK"
                            exit 1
                        fi

                        echo "[3/3] Testing stats-service API endpoint (/api/stats)..."
                        STATS_STATUS=\$(curl -s -o /dev/null -w "%{http_code}" --retry 5 --retry-delay 5 --max-time 10 "http://${env.ALB_DNS}/api/stats")
                        echo "GET /api/stats HTTP Response Code: \$STATS_STATUS"
                        if [ "\$STATS_STATUS" != "200" ]; then
                            echo "[ERROR] stats-service API did not return 200 OK"
                            exit 1
                        fi

                        echo "=========================================================="
                        echo " [SUCCESS] All Stage 3 Microservices Verified & Healthy!   "
                        echo "=========================================================="
                    """
                }
            }
        }
    }

    post {
        failure {
            script {
                echo "[ALERT] Pipeline execution failed! Initiating automated rollback on Master node..."
                sh """
                    if [ -n "${env.MASTER_INSTANCE_ID}" ] && [ "${env.MASTER_INSTANCE_ID}" != "None" ]; then
                        echo "Triggering kubectl rollout undo via AWS SSM..."
                        cat << EOF > /tmp/ssm-rollback-params.json
{
  "commands": [
    "kubectl rollout undo deployment/task-service -n ${K8S_NAMESPACE} || true",
    "kubectl rollout undo deployment/stats-service -n ${K8S_NAMESPACE} || true"
  ]
}
EOF
                        aws ssm send-command \
                            --instance-ids "${env.MASTER_INSTANCE_ID}" \
                            --document-name "AWS-RunShellScript" \
                            --comment "Automated Rollback on Deployment Failure" \
                            --parameters file:///tmp/ssm-rollback-params.json \
                            --region ${AWS_REGION} || true
                        rm -f /tmp/ssm-rollback-params.json || true
                    fi
                """
            }
        }
        always {
            script {
                echo "Cleaning up local build workspace and dangling Docker images..."
                sh """
                    docker image prune -f || true
                    rm -rf /tmp/k8s-rendered || true
                """
            }
        }
    }
}
