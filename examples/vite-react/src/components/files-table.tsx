import { IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatBytes } from "@/lib/format";
import { orpc } from "@/lib/orpc";

/** The signed-in user's finished uploads, read by `files.list` from cloudrop's table, each with a delete. */
export function FilesTable() {
  const queryClient = useQueryClient();
  const files = useQuery(orpc.files.list.queryOptions());
  const remove = useMutation(
    orpc.files.delete.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.files.key() }),
    }),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your files</CardTitle>
      </CardHeader>
      <CardContent>
        {files.error && <p role="alert">{files.error.message}</p>}
        {remove.error && <p role="alert">{remove.error.message}</p>}
        <Table aria-label="Your files">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Route</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {files.data?.map((file) => (
              <TableRow key={file.id}>
                <TableCell className="max-w-48 truncate">{file.name}</TableCell>
                <TableCell>
                  <Badge variant="secondary">{file.route}</Badge>
                </TableCell>
                <TableCell>{formatBytes(file.size)}</TableCell>
                <TableCell className="text-right">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Delete ${file.name}`}
                    disabled={remove.isPending}
                    onClick={() => remove.mutate({ id: file.id })}
                  >
                    <IconTrash />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {files.data?.length === 0 && <p className="text-sm text-muted-foreground">No files yet.</p>}
      </CardContent>
    </Card>
  );
}
